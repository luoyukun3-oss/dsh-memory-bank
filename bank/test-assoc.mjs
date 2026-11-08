// ============================================================================
// test-assoc —— 联想扩散的不变量（2026-10-27，随 assoc.mjs 改成扩散式一起立）
//
// 背景：联想从「三类各 2 个名额」改成「一个池取前 5、可含 1 条 2 跳」。
// 这套机制有三条**不许被改坏**的性质，正反两侧都测：
//   ① 联想**只追加、不参与主排序**（main 出现在联想之后 = 排序被污染）
//   ② 联想分数**必须 < INJECT_MIN_SCORE**（否则联想能自己触发注入 = 绕过噪声防线）
//   ③ 联想分数**必须 ≥ recall 的 minScore 0.45**（否则会被静默过滤，白算）
//   ④ 每次联想产出 ≤ 5 条（名额上限）
// ============================================================================
import { recall } from './search.mjs';
import { INJECT_MIN_SCORE } from './config-keys.mjs';

const MIN_RECALL_SCORE = 0.45;   // search.mjs 里 recall() 的默认 minScore
const MAX_ASSOC = 5;             // assoc.mjs 的 TOTAL

export function runAssocTests({ ok, real }) {
  const QS = ['成考什么时候报名', '做梦 联想 建边', '摸鱼模式怎么开', 'CUDA dll 找不到'];
  let orderOk = true;
  const tooHigh = [];
  const tooLow = [];
  const perQuery = [];

  for (const q of QS) {
    let seenAssoc = false;
    let n = 0;
    const { hits } = recall(real, q, { k: 15 });
    for (const h of hits) {
      const isAssoc = !!h.via;
      if (isAssoc) {
        seenAssoc = true;
        n += 1;
        if (h.score >= INJECT_MIN_SCORE) tooHigh.push(`${h.via}:${h.score}@${q}`);
        if (h.score < MIN_RECALL_SCORE) tooLow.push(`${h.via}:${h.score}@${q}`);
      } else if (seenAssoc) {
        orderOk = false;   // main 出现在联想后面 ⇒ 联想混进了主排序
      }
    }
    perQuery.push(n);
  }

  ok(orderOk, '联想只追加在 main 之后（不得参与主排序）', '');
  ok(tooHigh.length === 0, `联想分数必须 < INJECT_MIN_SCORE(${INJECT_MIN_SCORE})`, tooHigh.slice(0, 3).join('; '));
  ok(tooLow.length === 0, `联想分数必须 ≥ recall minScore(${MIN_RECALL_SCORE})，否则被静默过滤`, tooLow.slice(0, 3).join('; '));
  ok(Math.max(0, ...perQuery) <= MAX_ASSOC, `每次联想产出 ≤ ${MAX_ASSOC} 条`, `实测 ${perQuery.join('/')}`);
}
