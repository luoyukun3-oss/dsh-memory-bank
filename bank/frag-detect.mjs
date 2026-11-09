// 碎片复读检测（坡面二型 + 三型 2026-11-02）—— 2026-10-08 新增，独立模块（degenerate-audit.mjs 已有两个判据，别把行数堆上去）
// ============================================================
// 为什么需要它（起因是用户问的一句「看看你上个会话退化的程度」）：
//   查会话 `session-8cb103d2`（2026 条消息 / ctx 峰值 683k / 跨 9-30 → 10-08）时发现，
//   现有两条判据**都给它开了绿灯**：
//     ① `auditDegenerate`（只有 thinking、无正文无工具）报 **0 条**；
//     ② `auditSlope` 的双信号（同一短句≥10 **且** 出现「对思考本身的指令」）也报 **0 条**。
//   可原始指标分明在报警：短句「写」在**一条**思考里复读 **93 次**，`✓` 密度从每步 11.6 涨到 44.8、
//   `⇒` 从 6.4 涨到 38.3，滑窗拐点 t315@ctx≈436k 已触发 —— 而界面/日志看着"还在正常干活"。
//
//   真因：双信号的第二刀「元指令」是给**自我催促式**复读（「好。Go。（输出。）」）设计的，
//   而这一场的形态是**碎片 + 符号堆叠**（「写」「⇒好✓」），压根不含元指令 ⇒ 天然漏报。
//   ⇒ 这不是"阈值该调松一点"，而是**少了一条判据**（形态不同，信号也不同）。
//
// 判据 —— **两型**（阈值全部来自 config-keys.mjs，**别在这里写字面量**）：
//   二型：① 思考长度 ≥ FRAG_MIN_CHARS(400) ② 同一短句重复 ≥ REPEAT_MIN(10) ③ 碎片比 ≥ FRAG_RATIO_MIN(0.20)
//   三型（2026-11-02）：① 思考长度 ≥ FRAG_MIN_CHARS(400) ② 同一**自促词**重复 ≥ SELF_REPEAT_MIN(10)，**不看碎片比**
//
// 标定（2026-10-08 回放本仓库 85 个会话日志 / 7681 步，**阈值不是拍的**）：
//   | 阈值组合                        | 命中 | 都是些什么 |
//   | repeat≥10 & frag≥0.15 & ≥400字 | 42 步 / 5 文件 | 含 4 场已知坏会话 + 1 场同为「好」复读的 |
//   | repeat≥10 & frag≥0.20 & ≥400字 | 25 步 / 5 文件 | **本文件采用**：同上，步数更少、噪声更低 |
//   | 只看 repeat≥10（不看碎片比）     | 457 步 / 大量会话 | 技术词、代码片段的正常机械重复 ⇒ 虚警 |
//   | 只看 fragRatio 90 分位           | 分不开 | 干净会话中位 0.02 / 90分位 0.04，坏会话末段才 0.2~0.3 |
//   命中的 5 个会话文件全是真复读：09-18/09-25 那场的「好」×757、09-28 的「好」×216、
//   09-17 的「好」×132、上个会话的「写」×93；其余 80 个文件 0 命中 ⇒ **未见误报**。
//   ⚠️ 口径修正记录：首版标定时我排除了单字短句 ⇒ 会把「好」×757 这种最经典的形态漏掉
//   （原 slope 判据正是靠它立过功）。**单字必须算**，只排除纯符号/数字与技术词。
//   ⚠️ **2026-11-02 追加「三型」**（用户贴出 turn 41 的思考截图才发现漏报）：
//   上个会话末段「做。」复读 12/16/11 次，但 fragRatio 只有 0.06~0.11（短命令夹在大段分析中间）⇒ 本判据 0 命中。
//   全库回放 271 会话 / 16270 步后改成「自促词（好/做/写/跑…）复读 ≥10 次即命中、不看碎片比」：
//   命中 16 个会话文件，10 个连续 ≥2 步**全是已知坏会话**（好×757/×216/×132、写×93、做×19），
//   技术噪声（`</p`×36 等）因不在词表内被天然挡掉。阈值见 config-keys 的 SELF_REPEAT_MIN。
// ============================================================

import { REPEAT_MIN } from './slope-detect.mjs';
import { FRAG_MIN_CHARS, FRAG_RATIO_MIN, SELF_REPEAT_MIN } from './config-keys.mjs';
import { SELF_ORDER, fragmentOf } from './frag-metrics.mjs';

// —— 2026-11-09 按域拆（本文件当时 118/120 顶格）：指标与词表搬到 `frag-metrics.mjs` ——
//   「一条思考长什么样」是**纯函数、零 IO**，与「扫一批记录 / 判命中」是两件事。
//   ⚠️ **对外接口一字不变**：`test-frag.mjs` 仍从 `./frag-detect.mjs` 取这四个符号。
//   ⚠️ 三个阈值键（FRAG_MIN_CHARS / FRAG_RATIO_MIN / SELF_REPEAT_MIN）**故意留在本文件**：
//      `config-keys.mjs` 的 CONSUMERS 把它们登记在本文件，test-arch 第 17 节会断言
//      「登记的文件里真的出现该键名」⇒ 判定跟着阈值走，指标才搬得走。
export { SELF_ORDER, fragmentOf };

/**
 * 命中判定 —— **两型**，任一成立即命中：
 *   二型（2026-10-08）：思考 ≥ FRAG_MIN_CHARS **且** 同一短句 ≥ REPEAT_MIN **且** 碎片比 ≥ FRAG_RATIO_MIN；
 *   三型（2026-11-02）：思考 ≥ FRAG_MIN_CHARS **且** 同一**自促词**（SELF_ORDER）≥ SELF_REPEAT_MIN（**不看碎片比**）。
 * 为什么要三型：实测 turn 41「做」×16 的 fragRatio 只有 0.11（短命令夹在长分析里），二型整条链都漏。
 */
export function isFragmentHit(m) {
  if (m.chars < FRAG_MIN_CHARS) return false;
  if (SELF_ORDER.has(m.top) && m.repeat >= SELF_REPEAT_MIN) return true;
  return m.repeat >= REPEAT_MIN && m.fragRatio >= FRAG_RATIO_MIN;
}

/**
 * 扫一批记录，找出碎片复读的那些步。
 * ⚠️ 流中断（`interrupted` 或整条没有 usage）**跳过** —— 思考被硬切断不是复读，
 *    与 `auditDegenerate` 的 kind 分账、`slope-detect` 的 truncated 闸同源（开错处方的事踩过）。
 * @param {any[]} recs `readRecords()` / 逐行 JSON.parse 的结果
 * @returns {{hits:Array, first:object|null, count:number}}
 */
export function auditFragment(recs) {
  const hits = [];
  let at = 0;
  for (const r of recs || []) {
    if (r.type !== 'assistant/message') continue;
    at++;
    const blocks = Array.isArray(r.data?.message?.content) ? r.data.message.content : [];
    const reason = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text || '').join('');
    if (!reason) continue;
    const u = r.data?.usage || {};
    if (r.data?.interrupted === true || !Object.keys(u).length) continue;
    const m = fragmentOf(reason);
    if (!isFragmentHit(m)) continue;
    hits.push({
      at,
      turn: r.data?.turn,
      step: r.data?.step,
      ctxTokens: (u.inputTokens || 0) + (u.cacheReadTokens || 0),
      ...m,
    });
  }
  return { hits, first: hits[0] || null, count: hits.length };
}
