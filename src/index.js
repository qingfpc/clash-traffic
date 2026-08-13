// 入口：拉起采集循环与本地 HTTP 服务。
// 单实例依靠端口占用判定——重复启动会各自差分导致流量翻倍，必须避免。
import { spawn } from 'node:child_process';
import { appendFileSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, ROOT } from './db.js';
import { Collector } from './collector.js';
import { createServer } from './server.js';

const PORT = Number(process.env.CLASH_TRAFFIC_PORT) || 18900;
const HOST = '127.0.0.1';
const INTERVAL_MS = Number(process.env.CLASH_TRAFFIC_INTERVAL) || 5000;
const URL = `http://${HOST}:${PORT}/`;
const LOG_PATH = join(ROOT, 'data', 'service.log');
const LOG_MAX_BYTES = 1024 * 1024;

const shouldOpenBrowser = !process.argv.includes('--no-open');

function log(message) {
  const line = `[${new Date().toLocaleString()}] ${message}\n`;
  process.stdout.write(line);
  try {
    if (statSync(LOG_PATH).size > LOG_MAX_BYTES) truncateSync(LOG_PATH, 0);
  } catch {
    // 日志文件还不存在，忽略
  }
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // 磁盘问题不应该拖垮采集
  }
}

function openBrowser(url) {
  if (!shouldOpenBrowser) return;
  try {
    // start 的第一个参数会被当成窗口标题，必须留空。
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    log(`打开浏览器失败：${err.message}`);
  }
}

const db = openDatabase();
const collector = new Collector(db, { intervalMs: INTERVAL_MS });

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`正在停止（${reason}）`);

  collector.stop();
  server.close(() => {
    try {
      db.close();
    } catch {
      // 关闭失败不影响退出
    }
    log('已停止');
    process.exit(0);
  });

  // 兜底：连接迟迟不释放时强制退出。
  setTimeout(() => process.exit(0), 3000).unref();
}

const server = createServer({ db, collector, onShutdown: () => shutdown('收到停止指令') });

/** 端口被占不代表就是本应用，握手确认后才能判定为重复启动。 */
async function probeExistingInstance() {
  try {
    const res = await fetch(`${URL}api/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.app === 'clash-traffic' ? data : null;
  } catch {
    return null;
  }
}

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    const existing = await probeExistingInstance();
    if (existing) {
      log(`采集器已在运行（已采样 ${existing.collector.sampleCount} 次），本次不重复启动`);
      openBrowser(URL);
      process.exit(0);
    }
    log(`端口 ${PORT} 被其他程序占用，请设置环境变量 CLASH_TRAFFIC_PORT 换一个端口`);
    process.exit(2);
  }
  log(`服务启动失败：${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  collector.start();
  log(`采集器已启动，采样间隔 ${INTERVAL_MS / 1000} 秒`);
  log(`仪表盘 ${URL}`);
  openBrowser(URL);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log(`未捕获异常：${err.stack || err.message}`);
});
