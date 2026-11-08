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

// 关键判据：assistant/message 的 content 里有没有【可见正文/工具调用】，只有 reasoning 的就是「只想了没说」
const findings = [];
const comboStats = {};
const trunced = [];
let total = 0;

for (const f of walk(ROOT).sort()) {
  let text;
  try { text = decompressAll(fs.readFileSync(f)).toString('utf8'); } catch { continue; }
  const recs = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { recs.push(JSON.parse(line)); } catch {} }
  const short = f.replace(ROOT, '').split(path.sep).filter((s) => s !== '--E-2--').join('/').slice(0, 46);

  for (const r of recs) {
    if (r.type !== 'assistant/message') continue;
    total++;
    const msg = r.data?.message || {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const hasText = blocks.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim().length);
    const hasTool = blocks.some((b) => b.type === 'tool-call');
    const hasReason = blocks.some((b) => b.type === 'reasoning' && typeof b.text === 'string' && b.text.length);
    const key = `${hasReason ? 'R' : '-'}${hasText ? 'T' : '-'}${hasTool ? 'C' : '-'}`;
    comboStats[key] = (comboStats[key] || 0) + 1;

    if (hasReason && !hasText && !hasTool) {
      const reasonLen = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text.length).reduce((a, b) => a + b, 0);
      const u = r.data?.usage || msg.usage || {};
      findings.push({
        file: short, time: r.time, turn: r.data?.turn, step: r.data?.step,
        reasonChars: reasonLen, blocks: blocks.length, usage: u,
        tail: (blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')).slice(-120).replace(/\s+/g, ' '),
      });
    }
  }
}

console.log(`扫描 assistant/message 共 ${total} 条`);
console.log(`\n【组合分布】R=有思考 T=有正文 C=有工具调用`);
for (const [k, v] of Object.entries(comboStats).sort((a, b) => b[1] - a[1])) console.log(`  ${k} : ${v}`);

console.log(`\n【★ 只有思考、没有正文也没有工具调用】${findings.length} 条`);
for (const x of findings) {
  const u = x.usage || {};
  const usageStr = Object.keys(u).length ? JSON.stringify(u) : '(无)';
  console.log(`  ${t(x.time)} | turn ${x.turn}/step ${x.step} | 思考 ${x.reasonChars} 字 | blocks=${x.blocks} | usage=${usageStr}`);
  console.log(`      结尾: …${x.tail}`);
  console.log(`      文件: ${x.file}`);
}

// 顺带：这些"只想了没说"的消息之后，同一轮是不是马上结束了（没有后续 step 产出）
console.log('\n【对照：思考长度分布（全部含思考的消息）】');
