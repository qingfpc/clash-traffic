// 采集循环：定时拉取 mihomo 的活动连接快照，与上次比对算出增量，
// 按「分钟 + 维度组合」累加写库。
import { getConnections } from './clash.js';
import { upsertRows, setMeta } from './db.js';

const DIMENSION_SEPARATOR = '\u0001';

function extractDimensions(conn) {
  const meta = conn.metadata ?? {};

  const host = meta.host || meta.sniffHost || meta.destinationIP || '(unknown)';

  let proc = meta.process;
  if (!proc && meta.processPath) {
    proc = String(meta.processPath).split(/[\\/]/).pop();
  }
  if (!proc) proc = '(未知进程)';

  // chains 从出口到入口排列，第一个即流量实际走的节点。
  const chains = Array.isArray(conn.chains) ? conn.chains : [];
  const chain = chains.length ? String(chains[0]) : '(direct)';

  let rule = conn.rule || '(unknown)';
  if (conn.rulePayload) rule = `${rule}:${conn.rulePayload}`;

  const geoList = meta.destinationGeoIP;
  const geo = Array.isArray(geoList) && geoList.length ? String(geoList[0]) : '';

  return { proc, host, chain, rule, net: meta.network || '', geo };
}

export class Collector {
  constructor(db, { intervalMs = 5000 } = {}) {
    this.db = db;
    this.intervalMs = intervalMs;
    this.previous = new Map();
    this.timer = null;
    this.running = false;
    this.paused = false;
    // 首次采样只记录基线：此时连接上的累计值属于采集器启动前的存量。
    this.needsBaseline = true;

    this.startedAt = null;
    this.lastSampleAt = null;
    this.sampleCount = 0;
    this.errorCount = 0;
    this.lastError = null;
    this.connectionCount = 0;
    this.lastDelta = { up: 0, down: 0 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.needsBaseline = true;
    setMeta(this.db, 'lastStartedAt', this.startedAt);
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    // 暂停期间连接的累计值仍在增长，直接续算会把这段流量灌进恢复后的第一个桶。
    this.needsBaseline = true;
    this.previous.clear();
  }

  getStatus() {
    return {
      running: this.running,
      paused: this.paused,
      intervalMs: this.intervalMs,
      startedAt: this.startedAt,
      lastSampleAt: this.lastSampleAt,
      sampleCount: this.sampleCount,
      errorCount: this.errorCount,
      lastError: this.lastError,
      connectionCount: this.connectionCount,
      lastDelta: this.lastDelta
    };
  }

  async tick() {
    if (!this.running) return;

    if (!this.paused) {
      try {
        await this.sample();
        this.lastError = null;
      } catch (err) {
        this.errorCount++;
        this.lastError = err.message;
      }
    }

    if (this.running) {
      this.timer = setTimeout(() => this.tick(), this.intervalMs);
    }
  }

  async sample() {
    const snapshot = await getConnections();
    const connections = Array.isArray(snapshot?.connections) ? snapshot.connections : [];

    this.connectionCount = connections.length;
    this.lastSampleAt = Date.now();

    const seen = new Map();
    const buckets = new Map();
    const ts = Math.floor(Date.now() / 60000) * 60;
    let deltaUp = 0;
    let deltaDown = 0;

    for (const conn of connections) {
      const id = conn.id;
      if (!id) continue;

      const up = Number(conn.upload) || 0;
      const down = Number(conn.download) || 0;
      seen.set(id, { up, down });

      if (this.needsBaseline) continue;

      const prev = this.previous.get(id);
      const prevUp = prev ? prev.up : 0;
      const prevDown = prev ? prev.down : 0;

      // 计数器倒退只可能来自 id 复用或内核重置，此时以当前值为准。
      const incUp = up >= prevUp ? up - prevUp : up;
      const incDown = down >= prevDown ? down - prevDown : down;
      if (incUp <= 0 && incDown <= 0) continue;

      const dims = extractDimensions(conn);
      const key = [dims.proc, dims.host, dims.chain, dims.rule, dims.net, dims.geo].join(DIMENSION_SEPARATOR);

      let row = buckets.get(key);
      if (!row) {
        row = { ts, ...dims, up: 0, down: 0 };
        buckets.set(key, row);
      }
      row.up += incUp;
      row.down += incDown;
      deltaUp += incUp;
      deltaDown += incDown;
    }

    this.previous = seen;

    if (this.needsBaseline) {
      this.needsBaseline = false;
      return { baseline: true, connections: connections.length, rows: 0 };
    }

    const rows = [...buckets.values()];
    if (rows.length) upsertRows(this.db, rows);

    this.sampleCount++;
    this.lastDelta = { up: deltaUp, down: deltaDown };
    setMeta(this.db, 'lastSampleAt', this.lastSampleAt);

    return { baseline: false, connections: connections.length, rows: rows.length, up: deltaUp, down: deltaDown };
  }
}
