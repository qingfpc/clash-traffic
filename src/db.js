// SQLite 数据层。使用 Node 内置的 node:sqlite，无需任何 npm 依赖。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = join(ROOT, 'data', 'traffic.db');

// 分组维度会被拼进 SQL，必须先过白名单。
const GROUP_COLUMNS = new Set(['proc', 'host', 'chain', 'rule']);
export const OTHER_LABEL = '其他';

// 时间桶候选，从分钟到天。
const BUCKET_CANDIDATES = [60, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];

export function timezoneOffsetSeconds() {
  return -new Date().getTimezoneOffset() * 60;
}

/** 按跨度挑选时间桶，使柱子数不超过 maxBuckets。 */
export function pickBucketSeconds(spanSeconds, maxBuckets = 72) {
  for (const candidate of BUCKET_CANDIDATES) {
    if (spanSeconds / candidate <= maxBuckets) return candidate;
  }
  return BUCKET_CANDIDATES[BUCKET_CANDIDATES.length - 1];
}

function assertGroupColumn(groupBy) {
  if (!GROUP_COLUMNS.has(groupBy)) {
    throw new Error(`不支持的分组维度：${groupBy}`);
  }
  return groupBy;
}

export function openDatabase(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  // WAL 让查询不会被写入阻塞。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS traffic (
      ts    INTEGER NOT NULL,
      proc  TEXT NOT NULL,
      host  TEXT NOT NULL,
      chain TEXT NOT NULL,
      rule  TEXT NOT NULL,
      net   TEXT NOT NULL,
      geo   TEXT NOT NULL,
      up    INTEGER NOT NULL DEFAULT 0,
      down  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ts, proc, host, chain, rule, net, geo)
    ) WITHOUT ROWID
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic(ts)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  return db;
}

const UPSERT_SQL = `
  INSERT INTO traffic (ts, proc, host, chain, rule, net, geo, up, down)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (ts, proc, host, chain, rule, net, geo)
  DO UPDATE SET up = traffic.up + excluded.up, down = traffic.down + excluded.down
`;

/**
 * 批量累加写入。同一时间桶内相同维度组合的流量会累加而非覆盖，
 * 因此采集器每次采样都可以直接落库，不必在内存里攒满一分钟。
 */
export function upsertRows(db, rows) {
  if (!rows.length) return 0;

  const stmt = db.prepare(UPSERT_SQL);
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      stmt.run(row.ts, row.proc, row.host, row.chain, row.rule, row.net, row.geo, row.up, row.down);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

export function getSummary(db, from, to) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(up), 0)   AS up,
      COALESCE(SUM(down), 0) AS down,
      COALESCE(SUM(CASE WHEN chain = 'DIRECT' THEN up + down ELSE 0 END), 0) AS direct,
      COALESCE(SUM(CASE WHEN chain <> 'DIRECT' THEN up + down ELSE 0 END), 0) AS proxy,
      COUNT(DISTINCT host) AS hosts,
      COUNT(DISTINCT proc) AS procs
    FROM traffic
    WHERE ts >= ? AND ts < ?
  `).get(from, to);

  const up = Number(row.up);
  const down = Number(row.down);
  return {
    total: up + down,
    up,
    down,
    direct: Number(row.direct),
    proxy: Number(row.proxy),
    hosts: Number(row.hosts),
    procs: Number(row.procs)
  };
}

export function getRanking(db, { from, to, groupBy, limit = 20 }) {
  const column = assertGroupColumn(groupBy);
  const rows = db.prepare(`
    SELECT ${column} AS name,
           SUM(up)        AS up,
           SUM(down)      AS down,
           SUM(up + down) AS total
    FROM traffic
    WHERE ts >= ? AND ts < ?
    GROUP BY ${column}
    ORDER BY total DESC
    LIMIT ?
  `).all(from, to, limit);

  return rows.map((r) => ({
    name: r.name,
    up: Number(r.up),
    down: Number(r.down),
    total: Number(r.total)
  }));
}

/**
 * 堆叠面积图数据。先取流量最高的 topN 个分组，其余在 SQL 内归并为「其他」，
 * 避免域名基数大时把上万行明细传到前端。
 */
export function getSeries(db, { from, to, groupBy, topN = 9, bucketSeconds }) {
  const column = assertGroupColumn(groupBy);
  const bucket = bucketSeconds || pickBucketSeconds(Math.max(to - from, 60));
  const tz = timezoneOffsetSeconds();

  const topRows = db.prepare(`
    SELECT ${column} AS name, SUM(up + down) AS total
    FROM traffic
    WHERE ts >= ? AND ts < ?
    GROUP BY ${column}
    ORDER BY total DESC
    LIMIT ?
  `).all(from, to, topN);

  const topNames = topRows.map((r) => r.name);

  // 桶边界需要按本地时区对齐，否则按天聚合会切在 UTC 零点（本地早上八点）。
  const bucketExpr = `((((ts + ${tz}) / ${bucket}) * ${bucket}) - ${tz})`;

  let sql;
  let params;
  if (topNames.length > 0) {
    const placeholders = topNames.map(() => '?').join(', ');
    sql = `
      SELECT ${bucketExpr} AS bucket,
             CASE WHEN ${column} IN (${placeholders}) THEN ${column} ELSE ? END AS name,
             SUM(up + down) AS total
      FROM traffic
      WHERE ts >= ? AND ts < ?
      GROUP BY bucket, name
      ORDER BY bucket
    `;
    params = [...topNames, OTHER_LABEL, from, to];
  } else {
    sql = `
      SELECT ${bucketExpr} AS bucket, ${column} AS name, SUM(up + down) AS total
      FROM traffic
      WHERE ts >= ? AND ts < ?
      GROUP BY bucket, name
      ORDER BY bucket
    `;
    params = [from, to];
  }

  const rows = db.prepare(sql).all(...params);

  const bucketSet = new Set();
  const byName = new Map();
  for (const row of rows) {
    const b = Number(row.bucket);
    bucketSet.add(b);
    if (!byName.has(row.name)) byName.set(row.name, new Map());
    byName.get(row.name).set(b, Number(row.total));
  }

  const buckets = [...bucketSet].sort((a, b) => a - b);

  // 保持 topN 的流量顺序，「其他」始终排在最后。
  const orderedNames = topNames.filter((n) => byName.has(n));
  if (byName.has(OTHER_LABEL)) orderedNames.push(OTHER_LABEL);
  for (const name of byName.keys()) {
    if (!orderedNames.includes(name)) orderedNames.push(name);
  }

  const series = orderedNames.map((name) => {
    const points = byName.get(name);
    return { name, data: buckets.map((b) => points.get(b) ?? 0) };
  });

  return { bucketSeconds: bucket, buckets, series };
}

export function getDataRange(db) {
  const row = db.prepare('SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs, COUNT(*) AS rows FROM traffic').get();
  return {
    minTs: row.minTs === null ? null : Number(row.minTs),
    maxTs: row.maxTs === null ? null : Number(row.maxTs),
    rows: Number(row.rows)
  };
}

export function getDatabaseSize(path = DB_PATH) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
