// Windows 本机端口 → 进程名。mihomo 在 find-process-mode 非 always 时
// 不会填充 metadata.process，采集器需要自己用源端口反查。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 4000;

function localPort(addr) {
  const idx = String(addr).lastIndexOf(':');
  return idx >= 0 ? addr.slice(idx + 1) : '';
}

async function run(file, args) {
  const { stdout } = await execFileAsync(file, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS
  });
  return stdout;
}

export function parsePortToPid(stdout) {
  const map = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const proto = parts[0].toUpperCase();
    if (proto !== 'TCP' && proto !== 'UDP') continue;
    const port = localPort(parts[1]);
    const pid = Number(parts[parts.length - 1]);
    if (!port || !Number.isFinite(pid) || pid <= 0) continue;
    const key = `${proto}:${port}`;
    if (!map.has(key)) map.set(key, pid);
  }
  return map;
}

export function parsePidToName(stdout) {
  const map = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.split('","').map((s) => s.replace(/^"|"$/g, '').trim());
    if (cols.length < 2) continue;
    const pid = Number(cols[1]);
    if (cols[0] && Number.isFinite(pid)) map.set(pid, cols[0]);
  }
  return map;
}

async function portToPid() {
  return parsePortToPid(await run('netstat.exe', ['-ano']));
}

async function pidToName() {
  return parsePidToName(await run('tasklist.exe', ['/FO', 'CSV', '/NH']));
}

/**
 * 将一次 Windows 网络快照转换为无副作用的端口查询函数。
 * sourcePort 是客户端本地端口；TCP 监听端口不会与其匹配。
 */
export function createProcessLookup(ports, names) {
  return (network, sourcePort) => {
    if (!sourcePort) return '';
    const proto = String(network || 'tcp').toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
    const pid = ports.get(`${proto}:${sourcePort}`);
    if (!pid) return '';
    return names.get(pid) || '';
  };
}

/** 返回 (network, sourcePort) => 进程名，查不到时为空字符串。 */
export async function buildProcessLookup() {
  let ports;
  let names;
  try {
    [ports, names] = await Promise.all([portToPid(), pidToName()]);
  } catch {
    return () => '';
  }

  return createProcessLookup(ports, names);
}
