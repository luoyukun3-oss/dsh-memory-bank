/**
 * 推理退化扫描（2026-10-12 建，替代失效的 assistant/message 判据）
 *
 * 为什么需要它：装了 `empty-response-guard` 之后，「只有思考、无正文无工具调用」
 * 的调用在 `llm/stream` 层就被改写成 `error(EMPTY_RESPONSE)` 并触发重试，
 * **那次调用不再写 `assistant/message`**，只留 `assistant/attempt` + `llm/retry`。
 * ⇒ `bank/cli.mjs sweep` 的 ⑤ 段与 `tools/reasoning-only-audit.mjs`
 *   （两者都扫 assistant/message 的 R-- 组合）对这种退化是**假阴性**。
 *
 * 判据（两条，都要）：
 *   ① assistant/attempt 里 `finish.reason.kind === 'error'`
 *      且 `finish.reason.failure.code === 'EMPTY_RESPONSE'`
 *   ② usage 有值（有 usage ⇒ 不是流中断；流中断是「无 usage」）
 *
 * 上下文规模必须用 `usage.totalTokens` —— `inputTokens` 只是缓存未命中那部分
 * （实例：inputTokens=169 而 totalTokens=182,580）。
 *
 * 用法：
 *   node _dsh_memory/tools/degenerate-scan.mjs            # 全库汇总
 *   node _dsh_memory/tools/degenerate-scan.mjs --detail   # 附每条退化明细
 *   node _dsh_memory/tools/degenerate-scan.mjs --log      # 再读 harness.log 的 guard warn 密度
 */
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
const local = (ms) => (ms ? new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(5, 19) : '-');
const ROOT = path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'sessions');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.zstd')) acc.push(p);
  }
  return acc;
}

/** 从一个会话文件里抽出退化调用、provider、ctx。 */
function scanSession(file) {
  let text;
  try { text = decompressAll(fs.readFileSync(file)).toString('utf8'); } catch { return null; }
  const recs = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { recs.push(JSON.parse(line)); } catch {} }
  const providers = new Set();
  const degenerate = [];
  const others = {};
  for (const r of recs) {
    if (r.type === 'llm/retry' && r.data?.provider) providers.add(r.data.provider);
    if (r.type !== 'assistant/attempt') continue;
    const stream = r.data?.stream ?? [];
    let usage = null, finish = null, reasoningChars = 0;
    for (const item of stream) {
      const c = item.chunk ?? item;
      if (c.type === 'usage') usage = c.usage;
      else if (c.type === 'finish') finish = c.reason;
      else if (c.type === 'reasoning-delta') reasoningChars += (c.text || '').length;
    }
    const code = finish?.kind === 'error' ? (finish.failure?.code ?? '?') : (finish?.kind ?? '?');
    if (code !== 'EMPTY_RESPONSE') { others[code] = (others[code] || 0) + 1; continue; }
    degenerate.push({
      time: r.time,
      turn: r.data?.turn,
      step: r.data?.step,
      reasoningChars,
      ctx: usage?.totalTokens ?? 0,
      hasUsage: usage !== null,
    });
  }
  if (!degenerate.length) return null;
  const times = degenerate.map((d) => d.time);
  return {
    file,
    session: path.basename(path.dirname(file)).replace('session-', '').slice(0, 8),
    n: degenerate.length,
    first: Math.min(...times),
    last: Math.max(...times),
    ctxMin: Math.min(...degenerate.map((d) => d.ctx)),
    ctxMax: Math.max(...degenerate.map((d) => d.ctx)),
    providers: [...providers].join(','),
    noUsage: degenerate.filter((d) => !d.hasUsage).length,
    others,
    items: degenerate,
  };
}

const detail = process.argv.includes('--detail');
const withLog = process.argv.includes('--log');
const rows = [];
for (const f of walk(ROOT)) {
  const r = scanSession(f);
  if (r) rows.push(r);
}
rows.sort((a, b) => a.first - b.first);

if (!rows.length) {
  console.log('✅ 未发现推理退化（EMPTY_RESPONSE）记录。');
} else {
  console.log('会话 | 退化次数 | 首条(本地) | 末条(本地) | 退化时 ctx 区间 | provider | 无 usage');
  for (const r of rows) {
    console.log(`${r.session} | ${r.n} | ${local(r.first)} | ${local(r.last)} | ${r.ctxMin.toLocaleString()} ~ ${r.ctxMax.toLocaleString()} | ${r.providers || '-'} | ${r.noUsage}`);
  }
  console.log(`\n共 ${rows.length} 个会话、总计 ${rows.reduce((s, r) => s + r.n, 0)} 次推理退化。`);
  const oth = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.others)) oth[k] = (oth[k] || 0) + v;
  console.log(`（同批失败尝试里的其它 code，供区分「退化」与「流中断」：${JSON.stringify(oth)}）`);
}
if (detail) {
  console.log('\n=== 明细 ===');
  for (const r of rows) {
    console.log(`[${r.session}] provider=${r.providers}`);
    for (const d of r.items) {
      console.log(`  ${local(d.time)} | turn ${d.turn}/${d.step} | 思考 ${d.reasoningChars} 字 | ctx≈${d.ctx.toLocaleString()} tokens${d.hasUsage ? '' : ' | ⚠️ 无 usage（更像流中断）'}`);
    }
  }
}
if (withLog) {
  const logPath = path.join(process.env.APPDATA, 'dsh-desktop', 'logs', 'harness.log');
  console.log('\n=== harness.log 里 empty-response-guard 的 warn 密度（独立证据源）===');
  const byDay = {};
  if (fs.existsSync(logPath)) {
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2})T.*empty-response-guard: model returned a completed response with no text or tool call \((\d+) characters/);
      if (m) { const k = m[1]; byDay[k] = byDay[k] || { n: 0, chars: [] }; byDay[k].n++; byDay[k].chars.push(Number(m[2])); }
    }
  }
  for (const [k, v] of Object.entries(byDay).sort()) {
    const c = v.chars;
    console.log(`  ${k}（UTC 日期）: ${v.n} 条 | 思考 ${Math.min(...c)}~${Math.max(...c)} 字`);
  }
  if (!Object.keys(byDay).length) console.log('  （日志里没有 guard warn；可能日志已轮转）');
}
