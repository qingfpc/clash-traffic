// 通过 HTTP 接口请求采集器优雅退出。
const PORT = Number(process.env.CLASH_TRAFFIC_PORT) || 18900;
const BASE = `http://127.0.0.1:${PORT}/`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe() {
  try {
    const res = await fetch(`${BASE}api/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.app === 'clash-traffic' ? data : null;
  } catch {
    return null;
  }
}

async function main() {
  const status = await probe();
  if (!status) {
    console.log(`端口 ${PORT} 上没有运行中的采集器，无需停止。`);
    return;
  }

  console.log(`采集器运行中，已采样 ${status.collector.sampleCount} 次，正在请求停止...`);

  try {
    await fetch(`${BASE}api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'shutdown' }),
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    // 服务在响应写回前就退出属于正常情况
  }

  await sleep(800);
  console.log((await probe()) ? '停止指令已发送，但服务仍在响应，请稍后再试。' : '采集器已停止。');
}

await main();
// 双击运行时窗口会随进程退出立即关闭，留出时间让结果可读。
await sleep(2000);
