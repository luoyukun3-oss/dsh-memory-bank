// 备份 DSH 会话日志到工作区：把 sessions 目录下的 *.jsonl.zstd 复制到 _dsh_memory/sessions
// 用法：node backup_sessions.mjs
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.DSH_HOME || path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness');
const src = path.join(home, 'sessions');
const dest = 'E:/2/_dsh_memory/sessions';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

fs.mkdirSync(dest, { recursive: true });

/** 递归找出所有会话日志文件 */
function walk(dir, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.jsonl.zstd') || e.name.endsWith('.jsonl')) acc.push(p);
  }
  return acc;
}

const files = walk(src);
const manifest = [];
let total = 0;

for (const f of files) {
  const sessionDir = path.basename(path.dirname(f));
  const outName = `${sessionDir}__${path.basename(f)}`;
  const outPath = path.join(dest, outName);
  const buf = fs.readFileSync(f);
  fs.writeFileSync(outPath, buf);
  const st = fs.statSync(f);
  total += buf.length;
  manifest.push({
    backupName: outName,
    source: f,
    bytes: buf.length,
    modified: st.mtime.toISOString(),
  });
}

const summary = {
  backedUpAt: new Date().toISOString(),
  source: src,
  destination: dest,
  stamp,
  fileCount: manifest.length,
  totalBytes: total,
  files: manifest,
};

fs.writeFileSync(path.join(dest, `manifest-${stamp}.json`), JSON.stringify(summary, null, 2), 'utf8');
fs.writeFileSync(path.join(dest, 'manifest-latest.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log(`会话日志备份完成：${manifest.length} 个文件，共 ${(total / 1024 / 1024).toFixed(2)} MB`);
console.log(`目标目录：${dest}`);
