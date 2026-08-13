// 把 PowerShell 版采集器留下的 JSONL 数据导入 SQLite。
// 落库使用累加语义，因此必须防止同一文件被导入两次；这里在 meta 表记录每个文件
// 已导入的行数，重复运行只会补入新增行。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { openDatabase, upsertRows, getSummary, getMeta, setMeta, ROOT } from '../src/db.js';

const DATA_DIR = join(ROOT, 'data');

// PowerShell 的 Set-Content/Add-Content -Encoding UTF8 会写入 BOM，
// 不剥掉的话首行会带上 \uFEFF 导致 JSON.parse 失败。
function readJsonLines(path) {
  let content = readFileSync(path, 'utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return content.split(/\r?\n/).filter((l) => l.trim());
}

function parseLocalMinute(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function main() {
  if (!existsSync(DATA_DIR)) {
    console.log('没有 data 目录，无需导入。');
    return;
  }

  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  if (!files.length) {
    console.log('没有找到任何 .jsonl 文件，无需导入。');
    return;
  }

  const db = openDatabase();
  let totalImported = 0;
  let totalSkipped = 0;
  let sumUp = 0;
  let sumDown = 0;
  let badLines = 0;

  for (const file of files) {
    const full = join(DATA_DIR, file);
    const lines = readJsonLines(full);
    const key = `legacy:${basename(file)}`;
    const done = Number(getMeta(db, key) || 0);

    if (done >= lines.length) {
      console.log(`  ${file}  已导入过 ${done} 行，跳过`);
      totalSkipped += lines.length;
      continue;
    }

    const pending = lines.slice(done);
    const rows = [];
    for (const line of pending) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        badLines++;
        console.log(`    跳过无法解析的行：${line.slice(0, 80)}`);
        continue;
      }

      const ts = parseLocalMinute(obj.t);
      if (ts === null) {
        badLines++;
        console.log(`    跳过时间格式异常的行：t=${obj.t}`);
        continue;
      }

      const up = Number(obj.up) || 0;
      const down = Number(obj.down) || 0;
      sumUp += up;
      sumDown += down;

      rows.push({
        ts,
        proc: obj.proc || '(未知进程)',
        host: obj.host || '(unknown)',
        chain: obj.chain || '(direct)',
        rule: obj.rule || '(unknown)',
        net: obj.net || '',
        geo: obj.geo || '',
        up,
        down
      });
    }

    upsertRows(db, rows);
    setMeta(db, key, lines.length);
    totalImported += rows.length;
    console.log(`  ${file}  新导入 ${rows.length} 行（此前已导入 ${done} 行）`);
  }

  console.log('');
  console.log('导入完成');
  console.log(`  新导入行数 : ${totalImported}`);
  if (totalSkipped) console.log(`  跳过行数   : ${totalSkipped}`);
  if (badLines) console.log(`  解析失败   : ${badLines} 行`);
  console.log(`  本次流量   : 上行 ${formatBytes(sumUp)}  下行 ${formatBytes(sumDown)}`);

  const all = getSummary(db, 0, Math.floor(Date.now() / 1000) + 86400);
  console.log(`  库内总计   : ${formatBytes(all.total)}（上行 ${formatBytes(all.up)}  下行 ${formatBytes(all.down)}）`);
  console.log(`  直连/代理  : ${formatBytes(all.direct)} / ${formatBytes(all.proxy)}`);

  db.close();
}

main();
