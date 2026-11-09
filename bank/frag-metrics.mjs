// ============================================================================
// Memory Bank · frag-metrics —— 单条思考的「碎片复读」指标 + 自促词表（2026-11-09 按域拆出）
//
// 为什么单独一个文件：`frag-detect.mjs` 实测 118/120 行（98%，下一条就爆）。
//   按 budgets.json 的 `_principle`「只许瘦不许胖：超限先按域拆分，别压缩行宽硬塞」处理。
//
// 分工（这是拆分的**唯一**依据，不是按行数硬切）：
//   · 本文件 = **一条思考长什么样**：纯函数、零 IO、不认识会话记录 ⇒ `fragmentOf` + 自促词表；
//   · `frag-detect.mjs` = **扫一批记录 + 命中判定**：`auditFragment`（读 recs）与 `isFragmentHit`（读阈值）。
//
// ⚠️ `isFragmentHit` **故意留在 frag-detect.mjs**，不是随指标一起搬：
//   `config-keys.mjs` 的 CONSUMERS 把 FRAG_MIN_CHARS / FRAG_RATIO_MIN / SELF_REPEAT_MIN
//   的消费点登记为 `bank/frag-detect.mjs`，而 `test-arch.mjs` 第 17 节会断言
//   「登记表里声明的文件**真的出现该键名**」。三个阈值都只在 `isFragmentHit` 里用 ⇒
//   判定跟着阈值走、指标搬走，那条架构红线才保持绿（登记表本身不归本次改动范围）。
//
// 判据、两型/三型的定义与**全部标定数据**（为什么是 400 字 / 0.20 / 10 次）见 frag-detect.mjs 头注释。
// ============================================================================
import { TECH } from './slope-detect.mjs';

/** 多短算"碎片"（≤ 此长度的短句字符数计入分子）。 */
const FRAG_SENT_MAX = 6;
/** 超过这个长度的句子不算"复读短句"（与 slope-detect 的 SENT_MAX 一致）。 */
const SENT_MAX = 12;

/** 「自促词」（坡面三型，2026-11-02）：作为独立短句反复出现 ⇒ 是自己催自己，不是分析。
 *  词表只收**实测出现过**的（好/做/写/跑/嗯），外加同族动作词；⚠️ 别放 `TECH` 里的词（会被 TECH 先挡掉，
 *  如「输出」），也别收长句——`fragmentOf` 只统计 ≤12 字的句子。 */
export const SELF_ORDER = new Set(['好', '做', '写', '跑', '开跑', '干', '继续', '收工', '动手', '记下', '快', '嗯']);

/**
 * 单条思考的碎片指标。
 * @param {string} reason 思考文本
 * @returns {{top:string, repeat:number, fragRatio:number, chars:number}}
 *   top/repeat = 重复最多的那个短句及其次数（技术词、纯符号数字不计）；
 *   fragRatio = ≤FRAG_SENT_MAX 字的短句字符数 ÷ 全部短句字符数。
 */
export function fragmentOf(reason) {
  const text = String(reason || '');
  const counts = new Map();
  let total = 0, frag = 0;
  for (const raw of text.split(/[。！？\n]/)) {
    const s = raw.replace(/[*`#>\s]/g, '').trim();
    if (!s) continue;
    total += s.length;
    if (s.length <= FRAG_SENT_MAX) frag += s.length;
    if (s.length <= SENT_MAX) counts.set(s, (counts.get(s) || 0) + 1);
  }
  let top = '', repeat = 0;
  for (const [k, v] of counts) {
    if (v <= repeat) continue;
    if (TECH.has(k.toLowerCase())) continue;      // 反复念技术词是正常排查
    if (/^[^\p{L}]+$/u.test(k)) continue;         // 纯符号 / 纯数字（如 "/"、"}"）不算复读短句
    repeat = v; top = k;
  }
  return { top, repeat, fragRatio: total ? frag / total : 0, chars: text.length };
}
