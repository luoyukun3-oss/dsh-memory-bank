// 连续停滞判据（零依赖实现）—— 供 `cli sweep` ⑤ 段发现「看起来有进展、其实在重推」那类退化。
// ============================================================
// 为什么需要它：我们现有的 ⑤ 段只看**单条消息**（「只有 reasoning、无正文无工具」），
//   而那只是退化的形态之一。另一种形态**带着正文**：模型把上一步的推理材料换个说法重推，
//   每步都"有输出"⇒ 单条判据永远看不见，而内核补丁（把空回复映射成 EMPTY_RESPONSE）也无能为力。
//
// 判据来源：`@argszero/cordis-plugin-thinking-loop-guard` v0.1.8 的 `LoopDetector`
//   （`grams` / `repeatRatio` / `containment` / `observe` / `takeFire`），**逐条对齐**。
// ⚠️ 为什么不直接 import 那个插件：① `bank/` 一直守**零依赖**红线（只用 node: 内置）；
//   ② 插件可被卸载、升级或换版本 ⇒ 自检不能把命脉押在它身上。
//   ⇒ 代价是**两份实现会漂移**：所以这里逐字对齐上游，并在 `test.mjs` 里用同一批样本断言；
//     上游若改了判据，`faults.md` 那条会提醒我们回来对齐。
//
// ⚠️ 阈值**不是上游默认值**：`minReasoningChars` / `repeatRatio` 取的是 2026-09-19 用
//   我们自己 21 个会话 / 约 3200 个 model call 实测出来的那组（理由见 procedures.md：
//   默认 2048 在全库 fire 0 次；默认 0.5 会把含大量代码片段的正常思考误判成 low-entropy）。
// ============================================================

/** 固定窗口长度（与上游 `GRAM_SIZE` 一致）。定长窗口是**语言无关**的选择：
 *  中文循环（"好。执行。"）没有空白，按空白分词会塌成一个 token，永远分不出重复。 */
const GRAM_SIZE = 4;

/** 与 profile 里给插件配的那组保持一致（见 profiles\web\cordis.patch.yml 的注释）。 */
const DEFAULT_STALL_CONFIG = {
  maxThinkingSteps: 3,      // 连续几步停滞才认为成"循环"
  minReasoningChars: 512,   // 短于此的步骤**既不计数也不清零**（见 observeStalls）
  repeatRatio: 0.7,
  similarityThreshold: 0.8,
  maxFires: 4,
};

/**
 * 一段推理文本的**去重定长窗口**集合。
 * @param {string} text
 * @param {number} [size]
 * @returns {Set<string>} 文本短于窗口时为空集
 */
function grams(text, size = GRAM_SIZE) {
  const out = new Set();
  for (let i = 0; i + size <= text.length; i++) out.add(text.slice(i, i + size));
  return out;
}

/**
 * 低熵比：同一段文本里**已经出现过**的窗口占比。
 * 紧密重复（"好。执行。" × N）接近 1.0，而连贯推理（很少逐字重复窗口）接近 0。
 * @param {string} reasoning
 * @returns {number} 0..1
 */
export function repeatRatio(reasoning) {
  if (reasoning.length < 16) return 0;
  const k = Math.min(GRAM_SIZE, Math.max(2, Math.floor(reasoning.length / 16)));
  let repeated = 0;
  let total = 0;
  const seen = new Set();
  for (let i = 0; i + k <= reasoning.length; i++) {
    const gram = reasoning.slice(i, i + k);
    total++;
    if (seen.has(gram)) repeated++;
    else seen.add(gram);
  }
  return total === 0 ? 0 : repeated / total;
}

/**
 * 小集合被大集合包含的比例。
 * 用**包含度**而不是 Jaccard 是刻意的：卡住的模型通常是「复述上一步材料 + 再补一句」，
 * 新集合是旧集合的近似超集；Jaccard 会被新增内容稀释、把该步读成"有进展"。
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 任一侧为空则 0
 */
export function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const gram of small) if (large.has(gram)) shared++;
  return shared / small.size;
}

/**
 * 沿一串 model call 走一遍停滞判据，给出会在哪几步触发。
 * ⚠️ 关键行为（与上游一致，自己实现时最容易写错）：**短于 `minReasoningChars` 的步骤
 *   既不计入也不清零** —— 一句 "好，继续" 不能把前面攒起来的停滞计数抹掉。
 * @param {Array<{turn:number, step:number, hasOutput:boolean, reasoning:string}>} steps
 * @param {Partial<typeof DEFAULT_STALL_CONFIG>} [config]
 * @returns {{fires:Array<{turn:number,step:number,reason:string,runFrom:{turn:number,step:number}}>, fireCount:number, stalledNow:number}}
 */
export function observeStalls(steps, config = {}) {
  const cfg = { ...DEFAULT_STALL_CONFIG, ...config };
  let stalled = 0;
  let fired = 0;
  let previous;
  let runFrom = null;
  const fires = [];
  for (const s of steps) {
    const reasoning = s.reasoning || '';
    if (reasoning.length < cfg.minReasoningChars) continue;   // 短步骤：不计数、也不清零
    const current = grams(reasoning);
    const repeated = previous !== undefined && cfg.similarityThreshold > 0
      && containment(previous, current) >= cfg.similarityThreshold;
    previous = current;
    const reason = !s.hasOutput
      ? 'reasoning-only'
      : repeated
        ? 'repeated-material'
        : repeatRatio(reasoning) >= cfg.repeatRatio ? 'low-entropy' : undefined;
    if (reason === undefined) { stalled = 0; runFrom = null; continue; }   // 真进展 ⇒ 一次清零
    if (stalled === 0) runFrom = { turn: s.turn, step: s.step };
    stalled += 1;
    if (stalled >= cfg.maxThinkingSteps && fired < cfg.maxFires) {
      fired += 1;
      fires.push({ turn: s.turn, step: s.step, reason, runFrom });
      stalled = 0;   // 上游的行为：一次干预后重新攒（"a reaction does not latch"）
      runFrom = null;
    }
  }
  return { fires, fireCount: fires.length, stalledNow: stalled };
}
