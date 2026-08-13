// mihomo 内核客户端。Node 的 http.request 支持 socketPath 直连 Windows 命名管道，
// chunked 解码与 UTF-8 处理都由内置模块完成。
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_DIR = join(process.env.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev');
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml');
const DEFAULT_PIPE = '\\\\.\\pipe\\verge-mihomo';

let cached = null;

function readScalar(content, key) {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(content);
  if (!m) return null;
  return m[1].trim().replace(/^['"]/, '').replace(/['"]$/, '');
}

/** 从 Clash Verge 的配置里取出管道名与 API 密钥，结果会缓存。 */
export function getConnectionInfo({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  let secret = '';
  let pipeName = DEFAULT_PIPE;

  if (existsSync(CONFIG_FILE)) {
    const content = readFileSync(CONFIG_FILE, 'utf8');
    secret = readScalar(content, 'secret') || '';
    const pipe = readScalar(content, 'external-controller-pipe');
    if (pipe) pipeName = pipe;
  }

  cached = { pipeName, secret };
  return cached;
}

export function clashRequest(path, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
  const { pipeName, secret } = getConnectionInfo();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: pipeName,
        method,
        path,
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`mihomo 返回 HTTP ${res.statusCode}`));
            return;
          }
          if (!data) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`响应不是合法 JSON：${err.message}`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('连接 mihomo 超时')));
    req.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`找不到管道 ${pipeName}，请确认 Clash Verge 正在运行`));
      } else {
        reject(err);
      }
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export function getConnections() {
  return clashRequest('/connections');
}

export function getConfigs() {
  return clashRequest('/configs');
}
