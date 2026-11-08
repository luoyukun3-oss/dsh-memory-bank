import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decompressAll(buffer) {
  const marks = [];
  let i = buffer.indexOf(MAGIC);
  while (i !== -1) { marks.push(i); i = buffer.indexOf(MAGIC, i + 4); }
  if (!marks.length) return zlib.zstdDecompressSync(buffer);
  const parts = [];
  let pos = 0;
  while (pos < marks.length) {
    const end = pos + 1 < marks.length ? marks[pos + 1] : buffer.length;
    try { parts.push(zlib.zstdDecompressSync(buffer.subarray(marks[pos], end))); pos++; continue; } catch {}
    let k = pos + 1, ok = false;
    while (k < marks.length) {
      const e2 = k + 1 < marks.length ? marks[k + 1] : buffer.length;
      try { parts.push(zlib.zstdDecompressSync(buffer.subarray(marks[pos], e2))); pos = k + 1; ok = true; break; } catch { k++; }
    }
    if (!ok) break;
  }
  return Buffer.concat(parts);
}
const ROOT = path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'sessions');
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.zstd')) acc.push(p);
  }
  return acc;
}
const t = (ms) => (ms ? new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(5, 19) : '-');
const k = (n) => (n / 1000).toFixed(0) + 'k';

const rows = [];
for (const f of walk(ROOT).sort()) {
  let text; try { text = decompressAll(fs.readFileSync(f)).toString('utf8'); } catch { continue; }
  const short = f.replace(ROOT, '').split(path.sep).filter((s) => s !== '--E-2--').join('/').slice(0, 40);
  let turns = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'turn/start') turns++;
    if (r.type !== 'assistant/message') continue;
    const msg = r.data?.message || {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const hasText = blocks.some((b) => b.type === 'text' && b.text?.trim().length);
    const hasTool = blocks.some((b) => b.type === 'tool-call');
    const hasReason = blocks.some((b) => b.type === 'reasoning' && b.text?.length);
    const u = r.data?.usage || {};
    const ctx = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
    rows.push({ file: short, time: r.time, turn: r.data?.turn, ctx, hasUsage: ctx > 0, degenerate: hasReason && !hasText && !hasTool });
  }
}

const withUsage = rows.filter((r) => r.hasUsage);
const degen = rows.filter((r) => r.degenerate);
console.log(`assistant/message 共 ${rows.length} 条；带 usage 的 ${withUsage.length} 条；退化(只有思考) ${degen.length} 条\n`);

console.log('【退化条目的上下文大小】');
for (const d of degen) console.log(`  ${t(d.time)} turn ${d.turn} | ctx=${d.hasUsage ? k(d.ctx) : '(无 usage)'} | ${d.file}`);

console.log('\n【上下文分桶：全体 vs 退化】（只统计带 usage 的）');
const buckets = [[0, 50e3], [50e3, 100e3], [100e3, 200e3], [200e3, 400e3], [400e3, 600e3], [600e3, Infinity]];
for (const [lo, hi] of buckets) {
  const all = withUsage.filter((r) => r.ctx >= lo && r.ctx < hi);
  const dg = all.filter((r) => r.degenerate);
  const label = `${k(lo)}-${hi === Infinity ? '∞' : k(hi)}`;
  console.log(`  ${label.padEnd(12)} 总数 ${String(all.length).padStart(5)} | 退化 ${String(dg.length).padStart(3)} | 退化率 ${all.length ? ((dg.length / all.length) * 100).toFixed(2) : '0.00'}%`);
}

console.log('\n【每个会话：轮数 / 最大上下文 / 退化数】');
const byFile = {};
for (const r of rows) {
  const b = byFile[r.file] || (byFile[r.file] = { max: 0, degen: 0, maxTurn: null, msgs: 0 });
  b.msgs++;
  if (r.hasUsage && r.ctx > b.max) { b.max = r.ctx; b.maxTurn = r.turn; }
  if (r.degenerate) b.degen++;
}
const turnCount = {};
for (const f of walk(ROOT).sort()) {
  let text; try { text = decompressAll(fs.readFileSync(f)).toString('utf8'); } catch { continue; }
  const short = f.replace(ROOT, '').split(path.sep).filter((s) => s !== '--E-2--').join('/').slice(0, 40);
  let n = 0;
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { if (JSON.parse(line).type === 'turn/start') n++; } catch {} }
  turnCount[short] = n;
}
const table = Object.entries(byFile).map(([f, b]) => ({ file: f, turns: turnCount[f] || 0, maxCtx: k(b.max), maxTurn: b.maxTurn, degen: b.degen }))
  .sort((a, b) => b.degen - a.degen);
for (const r of table) console.log(`  ${r.file.padEnd(42)} 轮数=${String(r.turns).padStart(4)} 最大ctx=${String(r.maxCtx).padStart(7)} (turn ${r.maxTurn}) 退化=${r.degen}`);
