const PALETTE = [
  '#4a9d7a', '#a3c4e8', '#5b8dd9', '#e8a0c8', '#b5d99c',
  '#f2d06b', '#e8825f', '#d9536f', '#a8dcd4', '#8a94a6'
];

const REFRESH_MS = 5000;

const state = {
  range: '24h',
  groupBy: 'proc',
  paused: false
};

const el = {
  rangeTabs: document.getElementById('rangeTabs'),
  stateDot: document.getElementById('stateDot'),
  stateText: document.getElementById('stateText'),
  toggleBtn: document.getElementById('toggleBtn'),
  statTotal: document.getElementById('statTotal'),
  statUpDown: document.getElementById('statUpDown'),
  statDirect: document.getElementById('statDirect'),
  statDirectPct: document.getElementById('statDirectPct'),
  statProxy: document.getElementById('statProxy'),
  statProxyPct: document.getElementById('statProxyPct'),
  statScope: document.getElementById('statScope'),
  statScopeHint: document.getElementById('statScopeHint'),
  groupBy: document.getElementById('groupBy'),
  chart: document.getElementById('chart'),
  chartEmpty: document.getElementById('chartEmpty'),
  chartSub: document.getElementById('chartSub'),
  rankTitle: document.getElementById('rankTitle'),
  rankBody: document.getElementById('rankBody'),
  rankEmpty: document.getElementById('rankEmpty'),
  footInfo: document.getElementById('footInfo')
};

const chart = echarts.init(el.chart);
let lastSeriesSignature = '';

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatBucket(ts, bucketSeconds) {
  const d = new Date(ts * 1000);
  if (bucketSeconds < 3600) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (bucketSeconds < 86400) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86400).toFixed(1)} 天`;
}

function bucketLabel(seconds) {
  if (seconds < 3600) return `${seconds / 60} 分钟`;
  if (seconds < 86400) return `${seconds / 3600} 小时`;
  return '1 天';
}

// 域名与进程名来自网络流量，渲染前必须转义。
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} 返回 ${res.status}`);
  return res.json();
}

function renderStatus(status) {
  const c = status.collector;
  state.paused = c.paused;

  let cls = 'dot live';
  let text = `采集中 · ${c.connectionCount} 个连接`;

  if (!c.running) {
    cls = 'dot error';
    text = '采集器未运行';
  } else if (c.paused) {
    cls = 'dot paused';
    text = '已暂停';
  } else if (c.lastError) {
    cls = 'dot error';
    text = `采集异常：${c.lastError}`;
  }

  el.stateDot.className = cls;
  el.stateText.textContent = text;
  el.toggleBtn.textContent = c.paused ? '恢复采集' : '暂停采集';

  const parts = [`已采样 ${c.sampleCount} 次`];
  if (c.lastSampleAt) parts.push(`最后采样 ${formatClock(c.lastSampleAt)}`);
  parts.push(`数据库 ${formatBytes(status.dbBytes)}`);
  el.footInfo.textContent = `${parts.join(' · ')}　|　数据仅覆盖采集器运行期间`;

  const range = status.data;
  if (range && range.minTs) {
    el.statScope.textContent = formatDuration(range.maxTs - range.minTs + 60);
    el.statScopeHint.textContent = `${formatClock(range.minTs * 1000)} 起 · ${range.rows} 条记录`;
  } else {
    el.statScope.textContent = '暂无数据';
    el.statScopeHint.textContent = '采集器刚启动，稍候即可看到数据';
  }
}

function renderStats(summary) {
  el.statTotal.textContent = formatBytes(summary.total);
  el.statUpDown.textContent = `上行 ${formatBytes(summary.up)} / 下行 ${formatBytes(summary.down)}`;
  el.statDirect.textContent = formatBytes(summary.direct);
  el.statProxy.textContent = formatBytes(summary.proxy);

  const total = summary.total || 1;
  el.statDirectPct.textContent = `占 ${((summary.direct / total) * 100).toFixed(1)}% · 不消耗套餐`;
  el.statProxyPct.textContent = `占 ${((summary.proxy / total) * 100).toFixed(1)}% · 消耗机场套餐`;
}

function renderChart(data) {
  const hasData = data.buckets.length > 0 && data.series.length > 0;
  el.chartEmpty.hidden = hasData;
  el.chart.style.display = hasData ? '' : 'none';
  el.chartSub.textContent = `每根柱子代表 ${bucketLabel(data.bucketSeconds)} 内消耗的流量，粒度随时间跨度自动调整`;

  if (!hasData) {
    chart.clear();
    lastSeriesSignature = '';
    return;
  }

  const labels = data.buckets.map((ts) => formatBucket(ts, data.bucketSeconds));
  const signature = `${data.groupBy}|${data.series.map((s) => s.name).join('\u0001')}|${labels.length}`;
  const notMerge = signature !== lastSeriesSignature;
  lastSeriesSignature = signature;

  chart.setOption({
    color: PALETTE,
    animationDuration: 300,
    grid: { left: 8, right: 16, top: 12, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: '#c9c9c6' } },
      backgroundColor: '#ffffff',
      borderColor: '#e0e0dd',
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: '#1f2328', fontSize: 12 },
      formatter(params) {
        const rows = params.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
        const total = params.reduce((sum, p) => sum + (Number(p.value) || 0), 0);
        if (!rows.length) return `${params[0].axisValue}<br>无流量`;
        const lines = rows
          .map((p) => `${p.marker}${escapeHtml(p.seriesName)} <b>${formatBytes(p.value)}</b>`)
          .join('<br>');
        return `<div style="margin-bottom:4px;color:#6b7280">${params[0].axisValue}</div>${lines}` +
          `<div style="margin-top:5px;padding-top:5px;border-top:1px solid #eee;color:#6b7280">合计 ${formatBytes(total)}</div>`;
      }
    },
    legend: {
      bottom: 0,
      icon: 'roundRect',
      itemWidth: 9,
      itemHeight: 9,
      itemGap: 14,
      textStyle: { fontSize: 12, color: '#4b5563' }
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: '#e0e0dd' } },
      axisTick: { show: false },
      axisLabel: { color: '#9ca3af', fontSize: 11 }
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#f0f0ee' } },
      axisLabel: { color: '#9ca3af', fontSize: 11, formatter: (v) => formatBytes(v) }
    },
    series: data.series.map((s) => ({
      name: s.name,
      type: 'line',
      stack: 'total',
      smooth: 0.2,
      symbol: 'none',
      lineStyle: { width: 1 },
      areaStyle: { opacity: 0.82 },
      emphasis: { focus: 'series' },
      data: s.data
    }))
  }, { notMerge, lazyUpdate: true });
}

function renderRanking(data) {
  const items = data.items || [];
  el.rankTitle.textContent = `${data.groupLabel}消耗排行`;
  el.rankEmpty.hidden = items.length > 0;

  if (!items.length) {
    el.rankBody.innerHTML = '';
    return;
  }

  const max = items[0].total || 1;
  const total = data.total || 1;

  el.rankBody.innerHTML = items.map((item, index) => {
    const name = escapeHtml(item.name);
    const width = ((item.total / max) * 100).toFixed(1);
    const share = ((item.total / total) * 100).toFixed(1);
    const color = PALETTE[index % PALETTE.length];
    return `<tr>
      <td class="col-rank">${index + 1}</td>
      <td class="rank-name" title="${name}">${name}</td>
      <td class="col-bar"><div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${color}"></div></div></td>
      <td class="col-num">${formatBytes(item.total)}</td>
      <td class="col-num dim">${formatBytes(item.up)}</td>
      <td class="col-num dim">${formatBytes(item.down)}</td>
      <td class="col-num dim">${share}%</td>
    </tr>`;
  }).join('');
}

async function refresh() {
  const query = `range=${state.range}&groupBy=${state.groupBy}`;
  try {
    const [status, summary, series, ranking] = await Promise.all([
      api('/api/status'),
      api(`/api/summary?range=${state.range}`),
      api(`/api/series?${query}&topN=9`),
      api(`/api/ranking?${query}&limit=20`)
    ]);
    renderStatus(status);
    renderStats(summary);
    renderChart(series);
    renderRanking(ranking);
  } catch (err) {
    el.stateDot.className = 'dot error';
    el.stateText.textContent = `连接服务失败：${err.message}`;
  }
}

el.rangeTabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-range]');
  if (!button) return;
  state.range = button.dataset.range;
  for (const b of el.rangeTabs.querySelectorAll('button')) {
    b.classList.toggle('active', b === button);
  }
  refresh();
});

el.groupBy.addEventListener('change', () => {
  state.groupBy = el.groupBy.value;
  refresh();
});

el.toggleBtn.addEventListener('click', async () => {
  const action = state.paused ? 'resume' : 'pause';
  el.toggleBtn.disabled = true;
  try {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    await refresh();
  } finally {
    el.toggleBtn.disabled = false;
  }
});

window.addEventListener('resize', () => chart.resize());

refresh();
setInterval(refresh, REFRESH_MS);
