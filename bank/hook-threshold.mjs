// ============================================================================
// Memory Bank · hook-threshold —— hook 召回阈值的**唯一**体检实现（2026-11-08）
//
// 为什么要有这个文件（这不是重构癖）：
//   阈值 `INJECT_MIN_SCORE` 是**绝对值**，而分数标度跟着索引规模漂
//   （`idfOf = log(1 + N/df)`，N = index.json 的 docs 数）。索引每增删一批文档，
//   这个标定就**悄悄失效一次**，症状是「召回突然变少」，极难归因 ——
//   2026-11-08 当天就差点被归因成「⑬ 改坏了检索」，查了半天才发现是 index 从 2288 去重到 1056。
//
//   ⇒ 所以把「体检」抽成**一个实现、两个消费者**：
//     · `recall-eval.mjs` —— 给人看表格（阈值扫描 + 余量）
//     · `test.mjs` 第 32 节 —— 自动守护（余量或触发率掉出安全区就红）
//   两处各写一份必然漂移（本项目已有先例：MIN_SCORE 曾在 4 处各写一遍）。
//
// ⚠️ 与 hook 严格同参：`{ k: 4, budget: 1100, withGlobal: false }`
//   `withGlobal: false` 是 2026-11-08 补的 —— 旧版 `recall-eval` 的 sim() 漏了它，
//   等于带着 400 字全局偏好去测（虽然不影响 score，但注入字数统计虚高 400，是失真数据）。
// ============================================================================
import { recall } from './search.mjs';
import { INJECT_MIN_SCORE } from './config-keys.mjs';

/** hook 调用召回时的真实参数（改这里就等于改 hook 口径，改前先看 user-prompt.mjs:87）。 */
const HOOK_RECALL_OPTS = { k: 4, budget: 1100, withGlobal: false };

/**
 * 跑一轮体检。
 * @param {string} dir 仓库目录
 * @param {{related:string[], irrelated:string[], thr?:number}} opts
 * @returns {{thr:number, relatedFired:number, relatedTotal:number, irrFired:number, irrTotal:number,
 *            avgChars:number, noiseFloor:number, margin:number, relatedTop:number[]}}
 */
export function checkHookThreshold(dir, { related, irrelated, thr = INJECT_MIN_SCORE }) {
  const sim = (q) => {
    const { hits, text } = recall(dir, q, HOOK_RECALL_OPTS);
    const strong = hits.filter((h) => h.score >= thr);
    return { fire: strong.length > 0, len: strong.length ? text.length : 0 };
  };
  const rel = related.map(sim);
  const irr = irrelated.map(sim);
  const fired = rel.filter((r) => r.fire);
  const avgChars = fired.length ? Math.round(fired.reduce((a, b) => a + b.len, 0) / fired.length) : 0;
  // 噪声地板 = 无关提问的最高分（用 minScore:0 拿全量，否则低分噪声会被门槛吃掉、地板被低估）
  const irrTop = irrelated.map((q) => recall(dir, q, { ...HOOK_RECALL_OPTS, minScore: 0 }).hits[0]?.score || 0);
  const relatedTop = related.map((q) => recall(dir, q, { ...HOOK_RECALL_OPTS, minScore: 0 }).hits[0]?.score || 0);
  const noiseFloor = irrTop.length ? Math.max(...irrTop) : 0;
  return {
    thr,
    relatedFired: fired.length,
    relatedTotal: rel.length,
    irrFired: irr.filter((r) => r.fire).length,
    irrTotal: irr.length,
    avgChars,
    noiseFloor,
    // 余量 = 阈值 / 噪声地板。> 1 才有效；经验上低于 2× 该警惕（见 config-keys 标定史）。
    margin: noiseFloor > 0 ? thr / noiseFloor : Infinity,
    relatedTop,
  };
}

/** 安全区判据（test.mjs 与 recall-eval.mjs 共用，别在两处各写一遍）。 */
export const SAFE = {
  /** 阈值余量下限：低于它说明噪声快追上阈值了，标定要重做。 */
  MIN_MARGIN: 1.3,
  /** 相关提问触发率下限（比例）：低于它说明阈值太严，真相关的记忆在静默。 */
  MIN_RELATED_FIRED_RATIO: 14 / 18,
};

/** 把体检结果转成「红/绿」判定，返回问题列表（空数组 = 健康）。 */
export function thresholdProblems(r) {
  const out = [];
  if (r.margin < SAFE.MIN_MARGIN) {
    out.push(`阈值余量 ${r.margin.toFixed(2)}× < ${SAFE.MIN_MARGIN}×（噪声地板 ${r.noiseFloor.toFixed(2)}，阈值 ${r.thr}）`);
  }
  const ratio = r.relatedFired / r.relatedTotal;
  if (ratio < SAFE.MIN_RELATED_FIRED_RATIO) {
    out.push(`相关提问只触发 ${r.relatedFired}/${r.relatedTotal} < 14/18（阈值 ${r.thr} 太严，真相关的记忆在静默）`);
  }
  return out;
}
