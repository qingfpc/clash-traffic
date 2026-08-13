// HTTP 服务：对外提供聚合查询接口，并托管 web 目录下的静态页面。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import {
  ROOT,
  DB_PATH,
  getSummary,
  getSeries,
  getRanking,
  getDataRange,
  getDatabaseSize,
  pickBucketSeconds
} from './db.js';

const WEB_DIR = join(ROOT, 'web');
const SLOW_QUERY_MS = 200;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const RANGE_SECONDS = {
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
  '7d': 604800,
  '30d': 2592000
};

const GROUP_LABELS = {
  proc: '进程',
  host: '域名',
  chain: '出站节点',
  rule: '命中规则'
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function resolveRange(db, params) {
  const now = Math.floor(Date.now() / 1000);
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from) {
    return { from, to, range: 'custom' };
  }

  const range = params.get('range') || '24h';
  if (range === 'all') {
    const dataRange = getDataRange(db);
    // 上界多给一分钟，保证当前正在累加的时间桶被覆盖。
    return { from: dataRange.minTs ?? now - 3600, to: now + 60, range };
  }

  const seconds = RANGE_SECONDS[range] ?? RANGE_SECONDS['24h'];
  return { from: now - seconds, to: now + 60, range };
}

function resolveGroupBy(params) {
  const groupBy = params.get('groupBy') || 'proc';
  return GROUP_LABELS[groupBy] ? groupBy : 'proc';
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  // 归一化后必须仍落在 web 目录内，避免 ../ 穿越。
  const target = join(WEB_DIR, normalize(relative));
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const content = await readFile(target);
    const mime = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    if (relative === 'vendor/echarts.min.js') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('缺少 web/vendor/echarts.min.js，请先下载 ECharts 6.1.0 放入该路径。');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export function createServer({ db, collector, onShutdown }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const { pathname, searchParams } = url;

    if (!pathname.startsWith('/api/')) {
      await serveStatic(req, res, pathname);
      return;
    }

    const startedAt = Date.now();
    try {
      if (pathname === '/api/status') {
        const dataRange = getDataRange(db);
        sendJson(res, {
          // 供启动器确认端口后面确实是本应用，而不是别的程序占了端口。
          app: 'clash-traffic',
          collector: collector.getStatus(),
          data: dataRange,
          dbBytes: getDatabaseSize(DB_PATH),
          serverTime: Date.now(),
          groups: GROUP_LABELS
        });
      } else if (pathname === '/api/summary') {
        const { from, to, range } = resolveRange(db, searchParams);
        sendJson(res, { from, to, range, ...getSummary(db, from, to) });
      } else if (pathname === '/api/series') {
        const { from, to, range } = resolveRange(db, searchParams);
        const groupBy = resolveGroupBy(searchParams);
        const topN = Math.min(Math.max(Number(searchParams.get('topN')) || 9, 1), 20);
        const result = getSeries(db, { from, to, groupBy, topN });
        sendJson(res, { from, to, range, groupBy, groupLabel: GROUP_LABELS[groupBy], ...result });
      } else if (pathname === '/api/ranking') {
        const { from, to, range } = resolveRange(db, searchParams);
        const groupBy = resolveGroupBy(searchParams);
        const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 20, 1), 200);
        const items = getRanking(db, { from, to, groupBy, limit });
        const summary = getSummary(db, from, to);
        sendJson(res, { from, to, range, groupBy, groupLabel: GROUP_LABELS[groupBy], total: summary.total, items });
      } else if (pathname === '/api/control' && req.method === 'POST') {
        const body = await readBody(req);
        let action = '';
        try {
          action = JSON.parse(body || '{}').action || '';
        } catch {
          sendJson(res, { error: '请求体不是合法 JSON' }, 400);
          return;
        }

        if (action === 'pause') collector.pause();
        else if (action === 'resume') collector.resume();
        else if (action === 'shutdown') {
          sendJson(res, { ok: true, action });
          setTimeout(() => onShutdown?.(), 100);
          return;
        } else {
          sendJson(res, { error: `未知操作：${action}` }, 400);
          return;
        }
        sendJson(res, { ok: true, action, collector: collector.getStatus() });
      } else {
        sendJson(res, { error: 'Not Found' }, 404);
      }
    } catch (err) {
      sendJson(res, { error: err.message }, 500);
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed > SLOW_QUERY_MS) {
      // 同步的 SQLite 查询会占住事件循环，拖慢采集循环，超时要能被发现。
      console.warn(`[slow] ${pathname}${url.search} 耗时 ${elapsed}ms`);
    }
  });
}

export { pickBucketSeconds };
