#!/usr/bin/env node
/**
 * stuck-session-scan.mjs —— 排查「某个会话问什么都没反应」
 *
 * 为什么需要（2026-10-13 实例）：用户那个会话连敲「？？？」全无动静，界面两次
 * 「处理失败 400 INVALID_REQUEST」。三类"你没动静"里，这是**第三类**：
 *   ① 流中断（interrupted / 无 usage）      → 换会话没用
 *   ② 推理退化（有 usage、正文零 token）     → 必须换会话
 *   ③ 请求被上游硬拒（400 / usage 全 0）     → 换会话有用（坏料留在旧会话历史里）
 * 本工具一次跑完就把三类分开，并顺手揪出**畸形图片附件**（本次真凶：一张 4×5 像素的纯色 PNG）。
 *
 * 用法：
 *   node _dsh_memory/tools/stuck-session-scan.mjs                 # 全库
 *   node _dsh_memory/tools/stuck-session-scan.mjs 1a064076        # 只看 id 含此串的会话
 *   node _dsh_memory/tools/stuck-session-scan.mjs --min-side 32   # 图片短边小于此值算畸形
 */
import fs from 'node:fs';
import path from 'node:path';
import { decompressAll, transcriptHomes } from '../bank/core.mjs';

const argv = process.argv.slice(2);
const filter = argv.find((a) => !a.startsWith('--'));
const minSideArg = argv.findIndex((a) => a === '--min-side');
const MIN_SIDE = minSideArg >= 0 && argv[minSideArg + 1] ? Number(argv[minSideArg + 1]) : 32;

const roots = transcriptHomes().map((h) => path.join(h, 'sessions')).filter((d) => fs.existsSync(d));
const files = [];
const walk = (d) => {
  let es = [];
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl.zstd')) files.push(p);
  }
};
for (const r of roots) walk(r);

const bySession = new Map();
for (const f of files) {
  const m = f.match(/session-[0-9a-f-]{36}/);
  const id = m ? m[0] : path.basename(path.dirname(f));
  if (filter && !id.includes(filter) && !f.includes(filter)) continue;
  if (!bySession.has(id)) bySession.set(id, []);
  bySession.get(id).push(f);
}

const ts = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
let badTotal = 0, errTotal = 0;

for (const [id, fs_] of [...bySession.entries()].sort((a, b) =>
  Math.max(...b[1].map((f) => fs.statSync(f).mtimeMs)) - Math.max(...a[1].map((f) => fs.statSync(f).mtimeMs)))) {
  const errs = [];      // turn/end reason=error
  const attempts = [];  // assistant/attempt 里的失败
  const imgs = [];      // {seq,time,w,h,bytes,name}
  let lastTotal = 0, cw = 0;
  for (const f of fs_) {
    let text; try { text = decompressAll(fs.readFileSync(f)).toString('utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const d = o.data || {};
      // 取最大值：同一会话可能中途换过 provider/模型，最后一条 contextWindow 未必对应 ctx 峰值
      if (o.type === 'request/context' && d.contextWindow) cw = Math.max(cw, d.contextWindow);
      if (o.type === 'turn/end' && d.reason?.kind === 'error')
        errs.push({ seq: o.seq, time: o.time, turn: d.turn, msg: d.reason?.error?.message || '', code: d.reason?.error?.code || '' });
      if (o.type === 'assistant/attempt') {
        let usage = null, fail = null;
        for (const c of d.stream || []) {
          if (c.chunk?.type === 'usage') usage = c.chunk.usage;
          if (c.chunk?.type === 'finish' && c.chunk.reason?.kind === 'error') fail = c.chunk.reason.failure;
        }
        if (fail) attempts.push({ seq: o.seq, time: o.time, turn: d.turn, step: d.step, usage, msg: fail.message || '', code: fail.code || '' });
      }
      if (o.type === 'assistant/message') {
        for (const c of d.stream || []) if (c.chunk?.type === 'usage' && c.chunk.usage?.totalTokens) lastTotal = c.chunk.usage.totalTokens;
      }
      if (o.type === 'user/message') {
        for (const p of (d.content || [])) {
          if (p?.type !== 'image') continue;
          const a = p.attachment || {};
          imgs.push({ seq: o.seq, time: o.time, w: a.width, h: a.height, bytes: a.bytes, name: a.name, sha: String(a.attachmentId || '').replace(/^sha256:/, '').slice(0, 12) });
        }
      }
    }
  }
  const badImgs = imgs.filter((i) => !i.w || !i.h || Math.min(i.w, i.h) < MIN_SIDE);
  if (!errs.length && !badImgs.length) continue;   // 健康的会话不打扰
  errTotal += errs.length; badTotal += badImgs.length;

  console.log(`\n### ${id}`);
  if (cw) {
    const pct = (lastTotal / cw) * 100;
    console.log(`  ctx 峰值 ≈ ${lastTotal} / ${cw}（${pct.toFixed(1)}%）` +
      (pct > 100 ? ' ← ⚠️ 峰值超过记录到的 contextWindow ⇒ 该会话中途换过 provider/模型，百分比仅供参考'
        : pct > 90 ? ' ← 逼近上限' : ''));
  }
  for (const e of errs) console.log(`  ✗ turn${e.turn} @${ts(e.time)} seq${e.seq} [${e.code}] ${e.msg.slice(0, 160)}`);
  for (const a of attempts) {
    const zero = a.usage && !a.usage.inputTokens && !a.usage.outputTokens;
    console.log(`    · attempt t${a.turn}/s${a.step} @${ts(a.time)} usage=${a.usage ? `${a.usage.inputTokens}/${a.usage.outputTokens}` : 'none'}${zero ? ' ← 请求根本没进模型（查请求体，不是断流/退化）' : ''}`);
  }
  if (badImgs.length) {
    console.log(`  ⚠ 畸形图片附件 ${badImgs.length} 张（短边 < ${MIN_SIDE} 或尺寸缺失）：`);
    for (const i of badImgs) console.log(`     seq${i.seq} @${ts(i.time)} ${i.w}x${i.h} ${i.bytes}B ${i.sha} ${i.name}`);
  }
  const ok = imgs.filter((i) => i.w && i.h && Math.min(i.w, i.h) >= MIN_SIDE);
  // ⚠️ 这句只在"确有异常图"时才成立 —— 没有异常图时打印它属于误导（首版踩过）
  if (badImgs.length && ok.length)
    console.log(`  （同会话另有正常图片 ${ok.length} 张，如 ${ok.slice(0, 5).map((i) => `${i.w}x${i.h}`).join(' ')} ⇒ 发图本身没问题，问题只在上面那张异常的）`);
}
console.log(`\n扫描 ${bySession.size} 个会话：error turn ${errTotal} 条、畸形图片 ${badTotal} 张。`);
