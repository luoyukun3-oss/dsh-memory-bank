// ============================================================================
// Memory Bank · degenerate-audit-report —— ⑤/⑤b 段的**渲染层**（2026-11-09 按域拆出）
//   为什么拆：degenerate-audit.mjs 实测 239/240 行（100%，下一条改动就爆）。按预算表规矩拆。
//   本文件只做**字符串拼装**：不读盘、不算判据、不改任何状态 —— 输入是 auditDegenerate() 的返回值。
//   判据与阈值不在这里：斜坡见 slope-detect.mjs、碎片见 frag-detect.mjs、停滞见 stall-detect.mjs。
//   ⚠️ 对外零变化：degenerate-audit.mjs 用 `export { formatDegenerateReport } from ...` 转发，
//      调用方（cli.mjs sweep 第 ⑤ 段）只写 `for (const l of formatDegenerateReport(dg)) log(l);`。
// ============================================================================
import { guardLine } from './guard-degen-detect.mjs';
import { DEGEN_WINDOW_H } from './config-keys.mjs';

const WINDOW_H = DEGEN_WINDOW_H;      // 与 degenerate-audit.mjs 同值（单一真相源在 config-keys）

/**
 * 把审计结果格式化成 `cli.mjs sweep` 要打印的行。
 * ⚠️ 打印逻辑刻意放在**本模块**而不是 cli.mjs —— cli.mjs 曾因内联这段而逼近 95% 行数预算
 *    （2026-09-18 实测 324/340）。调用方只留一行：`for (const l of formatDegenerateReport(dg)) log(l);`
 * @param {ReturnType<typeof auditDegenerate>} dg
 * @returns {string[]} 每行一条
 */
export function formatDegenerateReport(dg) {
  if (!dg.ok) return [`⑤ 退化消息体检：跳过（${dg.reason}）`];
  // 「当前会话多大」是用户做取舍时要看的那个数（≥600k 才是退化高发区）⇒ 两种情况都带上
  const c = (dg.current && dg.current.ctx) || 0;
  const cur = c === 0 ? ''
    : `｜当前会话 ctx≈${Math.round(c / 1000)}k`
      + (c >= 600e3 ? ' ⚠️ 已在退化高发区（≥600k），尽快开新会话' : (c >= 400e3 ? '（逼近 600k 警戒线）' : ''));
  const deg = dg.hits.filter((h) => h.kind !== 'interrupted');
  const itr = dg.hits.length - deg.length;
  if (!deg.length && !itr) {
    return [`⑤ 推理退化消息：✅ 最近 ${dg.scanned} 个会话文件 / ${dg.messages} 条消息中 0 条${cur}`, slopeLine(dg), fragLine(dg), stallLine(dg), guardLine(dg.guard, guardScope(dg))];
  }
  const out = deg.length ? [`⑤ ⚠️ 推理退化 ${deg.length} 条（只有思考、无正文无工具，预算全烧在思考上 —— 见 faults「只有思考没有输出」）${cur}:`] : [`⑤ 推理退化消息：✅ 0 条${cur}`];
  for (const h of deg.slice(0, 6)) {
    const u = h.reasoningTokens != null ? `（output ${h.outputTokens} = reasoning ${h.reasoningTokens}）` : '';
    out.push(`   - turn ${h.turn}/step ${h.step}｜思考 ${h.reasonChars} 字${u}｜ctx≈${Math.round(h.ctxTokens / 1000)}k`);
  }
  if (deg.length) out.push('   → 立刻开新会话：这种消息会**连续传染**（空消息留在上下文里自我强化，实测连中五轮）');
  if (itr) out.push(`⑤b 流中断遗留 ${itr} 条（思考被硬切断 ⇒ **不是推理退化**，别为它开新会话；对照 faults「真·断流」条）`);
  out.push(slopeLine(dg));
  out.push(fragLine(dg));
  out.push(stallLine(dg));
  out.push(guardLine(dg.guard, guardScope(dg)));
  return out;
}

/**
 * 扫描范围说明 —— 挂在 guard 行尾。教训（2026-09-19）：「体检没报」先确认**扫描范围**，
 * 再怀疑判据 —— 本判据只看最近 `DEGEN_MAX_FILES` 个会话文件 / `DEGEN_WINDOW_H` 小时。
 * @param {ReturnType<typeof auditDegenerate>} dg
 * @returns {string}
 */
function guardScope(dg) {
  return `最近 ${dg.scanned} 个会话文件 / ${WINDOW_H}h · ${dg.messages} 条 assistant/message`;
}

/**
 * 「复读斜坡」那一行（2026-09-22 新增）—— 判据与阈值见 `bank/slope-detect.mjs`。
 * 为什么要单独报这一类：本文件原有的 `hits` 只抓"**坡底**"（既无正文也无工具调用），
 * 而实测 09-18 那场坡底仅 6 条、**坡面有 91 条**（其中双信号 49 条），最早一条在 **ctx 仅 328k** 时。
 * 坡面阶段**照样出正文、照样调工具** ⇒ 界面上"看着还在干活"，旧判据、内核补丁、连续停滞判据**都看不见它**。
 * ⇒ 这一行给的是「**从第几步起进入复读**」，比坡底早得多，是真正能救人的那个信号。
 * @param {ReturnType<typeof auditDegenerate>} dg
 * @returns {string}
 */
function slopeLine(dg) {
  const sp = dg.slope;
  if (!sp || !sp.count) return '   ↳ 复读斜坡判据（同一短句≥10次 **且** 出现「对思考本身的指令」）：✅ 未触发';
  const g = sp.groups[0];
  const f = g.hits[0];
  const where = `t${f.turn}/${f.step}｜ctx≈${Math.round((f.ctxTokens || 0) / 1000)}k｜重复「${f.top}」×${f.repeat}、元指令×${f.meta}`;
  const vis = g.hits.filter((h) => h.hasVisible).length;
  const maxRep = Math.max(...sp.groups.flatMap((x) => x.hits.map((h) => h.repeat)));
  // 「拐点」比"首次命中"更可信：首次命中可能只是正常排查时的机械重复（实测 ctx 43k 就有），
  // 而拐点=复读率首次≥30%且此后不回落，才是"这轮开始坏掉"的时刻（实测比坡底早 216k）。
  const knee = g.knee ? `；**拐点 t${g.knee.turn}（ctx≈${Math.round(g.knee.ctxTokens / 1000)}k，该窗口复读率 ${Math.round(g.knee.rate * 100)}%）**` : '';
  return `   ↳ ⚠️ 复读斜坡 **${sp.count} 条**（${sp.sessions} 个会话；双信号首次命中 ${where}${knee}）`
    + `—— 其中 ${vis} 条**照样有正文/工具调用**（界面看不出，旧判据也看不见）；最狠一条重复了 ${maxRep} 次`;
}

/**
 * 「碎片复读」那一行（2026-10-08 新增）—— 判据与标定表见 `bank/frag-detect.mjs`。
 * 它补的是**坡面的另一种形态**：`slopeLine` 要求出现「对思考本身的指令」（「好。Go。（输出。）」那类自我催促），
 * 而实测上个会话的复读长这样 —— 「写」×93、「⇒好✓」×45，**一个元指令都没有** ⇒ 双信号判据 0 命中，
 * 界面与日志全都干净。判据改成「同一短句≥10 **且** ≤6 字碎片占比≥0.20 **且** 思考≥400 字」，
 * 在 85 个会话 / 7681 步上只命中 5 个会话文件、全是真复读（详见模块头部标定表）。
 * ⚠️ 2026-11-02 补**三型**：用户贴出 turn 41 的「做。」×16 截图 —— fragRatio 只有 0.11，上面这条漏报；
 * 三型改为「同一自促词（好/做/写/跑…）≥10 即命中、不看碎片比」，全库标定见 config-keys 的 SELF_REPEAT_MIN。
 * @param {ReturnType<typeof auditDegenerate>} dg
 * @returns {string}
 */
function fragLine(dg) {
  const fr = dg.fragment;
  if (!fr || !fr.count) return '   ↳ 碎片复读判据（同句≥10 且 碎片比≥0.20，**或**自促词≥10 ⇒ 两型任一成立，均要求思考≥400 字）：✅ 未触发';
  const g = fr.groups[0];
  const f = g.hits[0];
  const maxRep = Math.max(...fr.groups.flatMap((x) => x.hits.map((h) => h.repeat)));
  return `   ↳ ⚠️ 碎片复读 **${fr.count} 步**（${fr.sessions} 个会话；首次 t${f.turn}/${f.step}｜ctx≈${Math.round((f.ctxTokens || 0) / 1000)}k`
    + `｜「${f.top}」×${f.repeat}、碎片比 ${f.fragRatio.toFixed(2)}；最狠一条重复 ${maxRep} 次）`
    + '—— 这类**不含元指令**，上面的双信号看不见它（判据与标定见 frag-detect.mjs）';
}

/**
 * 「连续停滞」那一行 —— ⑤ 的两条返回路径都要带上它，抽出来避免两处各写一遍。
 * 判据与阈值见 `bank/stall-detect.mjs`（零依赖复刻自 thinking-loop-guard 的 LoopDetector）。
 * 为什么要单独报这一类：它**可能带着正文**（把上一步的推理材料换个说法重推），
 * 于是单条判据（只看「只有 reasoning」）与内核补丁（把空回复映射成 EMPTY_RESPONSE）**都看不见它**。
 * @param {ReturnType<typeof auditDegenerate>} dg
 * @returns {string}
 */
function stallLine(dg) {
  const st = dg.stall;
  if (!st || !st.fireCount) return '   ↳ 连续停滞判据（连续 N 步「无可见产出」或「重复上一步材料」）：✅ 未触发';
  const where = st.fires.slice(0, 4).map((f) => `${String(f.session || '').replace(/^session-/, '').slice(0, 8)} t${f.turn}/${f.step}:${f.reason}`).join('、');
  return `   ↳ ⚠️ 连续停滞会触发 ${st.fireCount} 次（**这类可能带正文** ⇒ 单条判据与内核补丁都看不见）：${where}`;
}
