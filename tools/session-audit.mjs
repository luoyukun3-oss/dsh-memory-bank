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

const t = (ms) => (ms ? new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-');
const files = walk(ROOT).sort();
console.log(`会话日志文件共 ${files.length} 个\n`);

let seenStructure = false;
const allRetries = [];
const anomalies = [];

for (const f of files) {
  let text;
  try { text = decompressAll(fs.readFileSync(f)).toString('utf8'); } catch (e) { console.log(`!! 解压失败 ${f}: ${e.message}`); continue; }
  const recs = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { recs.push(JSON.parse(line)); } catch {} }
  if (!recs.length) continue;

  const times = recs.map((r) => r.time).filter(Boolean);
  const counts = {};
  for (const r of recs) counts[r.type] = (counts[r.type] || 0) + 1;

  const rel = f.replace(ROOT, '');
  const short = rel.split(path.sep).filter((s) => s !== '--E-2--').join('/').slice(0, 60);
  console.log('='.repeat(100));
  console.log(`${short}\n  记录 ${recs.length} 条 | ${t(Math.min(...times))} → ${t(Math.max(...times))} | ${(fs.statSync(f).size / 1048576).toFixed(2)} MB`);

  // 1) 重试 / 传输失败
  const retries = recs.filter((r) => r.type === 'llm/retry');
  console.log(`  llm/retry: ${retries.length} 次`);
  for (const r of retries) {
    const d = r.data || {};
    const line = `    ${t(r.time)}  turn=${d.turn} retry=${d.retry}/${d.maxRetries} code=${d.failure?.code} msg=${(d.failure?.message || '').slice(0, 80)}`;
    console.log(line);
    allRetries.push({ file: short, ...d, time: r.time });
  }

  // 2) 轮次收尾
  const starts = recs.filter((r) => r.type === 'turn/start').length;
  const ends = recs.filter((r) => r.type === 'turn/end');
  const reasons = {};
  for (const e of ends) { const k = e.data?.reason?.kind || JSON.stringify(e.data?.reason); reasons[k] = (reasons[k] || 0) + 1; }
  console.log(`  turn: start=${starts} end=${ends.length} 未收尾=${starts - ends.length} | 结束原因 ${JSON.stringify(reasons)}`);
  const endedTurns = new Set(ends.map((e) => e.data?.turn));
  const startedTurns = recs.filter((r) => r.type === 'turn/start').map((r) => r.data?.turn);
  const dangling = startedTurns.filter((x) => !endedTurns.has(x));
  if (dangling.length) console.log(`    ⚠️ 未收尾的轮次: ${dangling.join(', ')}`);

  // 3) 每一步是否产出了 assistant/message
  const stepStart = new Set(recs.filter((r) => r.type === 'step/start').map((r) => `${r.data?.turn}/${r.data?.step}`));
  const stepEnd = new Set(recs.filter((r) => r.type === 'step/end').map((r) => `${r.data?.turn}/${r.data?.step}`));
  const msgStep = new Set(recs.filter((r) => r.type === 'assistant/message').map((r) => `${r.data?.turn}/${r.data?.step}`));
  const noMsg = [...stepStart].filter((k) => !msgStep.has(k));
  const noEnd = [...stepStart].filter((k) => !stepEnd.has(k));
  console.log(`  step: start=${stepStart.size} end=${stepEnd.size} 有消息=${msgStep.size} | 无消息=${noMsg.length} 无收尾=${noEnd.length}`);
  if (noMsg.length) console.log(`    ⚠️ 没有产出消息的 step: ${noMsg.slice(0, 20).join(', ')}`);
  if (noEnd.length) console.log(`    ⚠️ 没有 step/end 的 step: ${noEnd.slice(0, 20).join(', ')}`);

  // 4) 单步结构（找 stop/finish 字段）
  if (!seenStructure) {
    const am = recs.find((r) => r.type === 'assistant/message');
    if (am) {
      seenStructure = true;
      console.log(`  --- assistant/message 结构键: ${JSON.stringify(Object.keys(am.data || {}))}`);
      console.log(`      message 键: ${JSON.stringify(Object.keys(am.data?.message || {}))}`);
      console.log(`      样例: ${JSON.stringify(am.data?.message).slice(0, 400)}`);
    }
  }

  // 5) 尝试流（有 attempt 但无对应 message）
  const attempts = recs.filter((r) => r.type === 'assistant/attempt');
  if (attempts.length) console.log(`  assistant/attempt: ${attempts.length} 次 → turns ${attempts.map((a) => a.data?.turn).join(',')}`);

  // 6) 其他错误类
  for (const r of recs) {
    if (/error|fail|abort|interrupt|cancel/i.test(r.type)) {
      anomalies.push(`${short} | ${t(r.time)} | ${r.type} | ${JSON.stringify(r.data).slice(0, 160)}`);
    }
  }
}

console.log('\n' + '='.repeat(100));
console.log(`【汇总】llm/retry 总计 ${allRetries.length} 次`);
const byCode = {};
for (const r of allRetries) byCode[r.failure?.code || '?'] = (byCode[r.failure?.code || '?'] || 0) + 1;
console.log(`  按 code: ${JSON.stringify(byCode)}`);
console.log(`\n【其他错误/中止类事件】${anomalies.length} 条`);
for (const a of anomalies.slice(0, 40)) console.log('  ' + a);
