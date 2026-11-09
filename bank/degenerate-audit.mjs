// 退化消息审计（2026-09-18 新增，独立模块 —— bank.mjs 已逼近行数预算，不再往里加功能）
// ============================================================
// 背景（2026-09-18 用户问「你怎么死了」的真因）：
//   我的推理会陷入「好。Go。好。（输出。）」这类**自我催促复读**，把输出预算全烧在
//   reasoning 上，产出【既无正文、也无工具调用】的空消息 —— 实测 `outputTokens`
//   **100% 等于 `reasoningTokens`**（1007/1007、976/976…），用户看到「只想了没说」。
//   ⚠️ 这种消息 DSH **记 `completed`、不报错、不重试**，所以日志里查不到异常：
//      `dsh-llm-deepseek` 只在 `order.length === 0`（一个 block 都没开）时判 EMPTY_RESPONSE，
//      只要 reasoning 开过 block 就按正常 `stop` 收尾（详见 faults「只有思考没有输出」条）。
//
// 用途：接进 `cli.mjs sweep` 做定期体检 —— 一出现就当场发现，不必等用户察觉。
//
// 实测依据（2026-09-18 全库 2584 条消息）：
//   退化只出现在**上下文 ≥ 600k tokens** 时（600k+ 区间 280 条中 6 条 = 2.14%，0~600k 全为 0%），
//   且**一旦出现就连续传染**（turn 42→46 连中五轮）⇒ 空消息留在上下文里自我强化。
//   ⇒ 所以「发现即换会话」是止损线。
// ⚠️ 2026-10-12 两处更正：① 「只在 ≥600k 退化」**已推翻**（实测 ctx 起点 147k/179k/346k/584k，
//   4 家 provider 各中招 ⇒ **ctx 小不构成安全感**）；② 追加**第四类**：被 `empty-response-guard`
//   拦下的退化不写 `assistant/message` ⇒ 本文件 `hits` 必然漏掉它，判据与打印见 `guard-degen-detect.mjs`。
// ⚠️ 2026-09-18 晚追加实证：判据必须**分两类**（见 auditDegenerate 里的 `kind`）——
//   「只有 reasoning」还有另一种成因：**流中断**（`interrupted`，思考被硬切断在半条命令上，
//   与 ctx 无关、思考本身正常）。上面「≥600k」的结论**只对退化类成立**，混报会开错处方。
// ⚠️ 2026-10-08 再追加**第三类**（见 frag-detect.mjs）：**碎片复读** —— 既不是空消息、
//   也不含「元指令」，所以上面两条判据都看不见它（实测上个会话命中 25 步、峰值「写」×93）。
// ============================================================

import fs from 'node:fs';
import { decompressAll, findTranscripts } from './bank.mjs';
import { observeStalls } from './stall-detect.mjs';
import { auditSlope } from './slope-detect.mjs';
import { auditFragment } from './frag-detect.mjs';
import { DEGEN_MAX_FILES, DEGEN_WINDOW_H } from './config-keys.mjs';
import { detectGuardDegenerate, guardLine } from './guard-degen-detect.mjs';

const MAX_FILES = DEGEN_MAX_FILES;    // 值见 config-keys.mjs（单一真相源）
const WINDOW_H = DEGEN_WINDOW_H;      // 同上；改动前先看 sweep 的耗时

/**
 * 扫描本仓库最近的会话日志，找出「只有 reasoning、无可见正文且无工具调用」的消息。
 * @param {string} cwd 工作区路径（用于定位会话日志）
 * @returns {{ok:boolean, reason?:string, scanned:number, messages:number, hits:Array}}
 */
export function auditDegenerate(cwd, { maxFiles = MAX_FILES, windowH = WINDOW_H } = {}) {
  const cutoff = Date.now() - windowH * 3600e3;
  let files = [];
  try {
    files = findTranscripts(cwd).filter((f) => f.mtime >= cutoff).slice(0, maxFiles);
  } catch (e) {
    return { ok: false, reason: e.message, scanned: 0, messages: 0, hits: [] };
  }
  if (!files.length) return { ok: true, scanned: 0, messages: 0, hits: [] };

  let messages = 0;
  let curCtx = 0;      // 当前会话（= 最新 mtime 那个日志文件）的最新上下文体积
  let curLabel = '';
  const hits = [];
  const stepsBy = new Map();   // 每个会话文件一条序列（停滞判据看的是序列，**不能跨会话拼**）
  const slopeBy = new Map();   // 每个会话一条「复读斜坡」序列（2026-09-22 新增，见 slope-detect.mjs）
  const fragBy = new Map();    // 每个会话一条「碎片复读」序列（2026-10-08 新增，见 frag-detect.mjs）
  const guardTotal = { count: 0, hits: [], providers: '' };   // 每个 guard 拦下的退化（2026-10-12 新增）
  for (const [fi, f] of files.entries()) {
    let text;
    try { text = decompressAll(fs.readFileSync(f.file)).toString('utf8'); } catch { continue; }
    const recsOfFile = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      recsOfFile.push(rec);
      if (rec.type !== 'assistant/message') continue;
      messages++;
      const u = rec.data?.usage || {};
      // files 已按 mtime 新→旧排序 ⇒ fi === 0 就是当前会话；循环走到最后拿到的即是它最新一条。
      if (fi === 0) { curCtx = (u.inputTokens || 0) + (u.cacheReadTokens || 0); curLabel = f.dirName; }
      const blocks = Array.isArray(rec.data?.message?.content) ? rec.data.message.content : [];
      const hasText = blocks.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim());
      const hasTool = blocks.some((b) => b.type === 'tool-call');
      const hasReason = blocks.some((b) => b.type === 'reasoning' && typeof b.text === 'string' && b.text.length);
      // 连续停滞判据要**每一步**（不只退化的那些）：无思考的步骤在判据里等同"太短"、既不计数也不清零。
      if (!stepsBy.has(fi)) stepsBy.set(fi, []);
      stepsBy.get(fi).push({
        turn: rec.data?.turn, step: rec.data?.step,
        hasOutput: hasText || hasTool,
        reasoning: blocks.filter((b) => b.type === 'reasoning').map((b) => b.text || '').join(''),
      });
      if (!hasReason || hasText || hasTool) continue;
      // 分类（2026-09-18 追加实证）：两类「只有 reasoning」的成因**完全不同**，混报会把流中断
      // 误报成"立刻开新会话"。① degenerate = 预算全烧在思考上（推理自我催促绕死，output==reasoning）；
      // ② interrupted = 流中断/被硬切断（data.interrupted 为真，或整条没有 usage），思考内容本身正常。
      const kind = (rec.data?.interrupted === true || !Object.keys(u).length) ? 'interrupted' : 'degenerate';
      hits.push({
        kind,
        session: f.dirName,
        time: rec.time,
        turn: rec.data?.turn,
        step: rec.data?.step,
        reasonChars: blocks.filter((b) => b.type === 'reasoning').reduce((n, b) => n + b.text.length, 0),
        outputTokens: u.outputTokens ?? null,
        reasoningTokens: u.reasoningTokens ?? null,
        ctxTokens: (u.inputTokens || 0) + (u.cacheReadTokens || 0),
      });
    }
    // 复读斜坡（2026-09-22 新增）：本文件原有的 hits 只抓"坡底"（无正文无工具），
    // 而实测坡面有 **91 条**、双信号 **49 条**，界面看着"还在干活" ⇒ 必须单独扫一遍。
    slopeBy.set(fi, { session: f.dirName, ...auditSlope(recsOfFile) });
    // 碎片复读（2026-10-08 新增）：坡面里**不含元指令**的那一类 —— 上个会话正是这种（「写」×93）。
    fragBy.set(fi, { session: f.dirName, ...auditFragment(recsOfFile) });
    const gd = detectGuardDegenerate(recsOfFile);   // 第四类，见文件头（不写 assistant/message）
    if (gd.count) {
      guardTotal.count += gd.count;
      guardTotal.hits.push(...gd.hits.map((h) => ({ ...h, session: f.dirName })));
      if (gd.providers) guardTotal.providers = gd.providers;
    }
  }
  // 每个会话各跑一遍序列判据再汇总（fire 点带上会话名，便于定位）
  const runs = [...stepsBy.entries()].map(([fi, st]) => ({ session: files[fi]?.dirName, ...observeStalls(st) }));
  const fires = runs.flatMap((r) => r.fires.map((f) => ({ ...f, session: r.session })));
  // 汇总斜坡：只取有命中的会话（按命中数降序），每条带上会话名
  const slopes = [...slopeBy.values()]
    .filter((s) => s.count)
    .sort((a, b) => b.count - a.count)
    .map((s) => ({ ...s, hits: s.hits.map((h) => ({ ...h, session: s.session })) }));
  // 汇总碎片复读：同上
  const frags = [...fragBy.values()]
    .filter((s) => s.count)
    .sort((a, b) => b.count - a.count)
    .map((s) => ({ ...s, hits: s.hits.map((h) => ({ ...h, session: s.session })) }));
  return {
    ok: true, scanned: files.length, messages, hits,
    stall: { sessions: runs.length, fireCount: fires.length, fires },
    slope: { sessions: slopes.length, count: slopes.reduce((n, s) => n + s.count, 0), groups: slopes },
    fragment: { sessions: frags.length, count: frags.reduce((n, s) => n + s.count, 0), groups: frags },
    current: { label: curLabel, ctx: curCtx },
    guard: guardTotal,
  };
}

// ---------------------------------------------------------------- 报告渲染（2026-11-09 按域拆到 degenerate-audit-report.mjs）
// 本文件 239/240 逼近红线 ⇒ 打印逻辑外移（先例：patch-status / perf-audit / lessons-audit-report）。
export { formatDegenerateReport } from './degenerate-audit-report.mjs';
