// ============================================================================
// test-threshold.mjs —— 第 32 节：hook 阈值标定不能悄悄失效（2026-11-08）
//
// 为什么这条值得一条测试（而不是"记得去看"）：
//   `INJECT_MIN_SCORE` 是**绝对值**，而分数标度跟着索引规模漂：
//       idfOf = log(1 + N / df)        // N = index.json 的 docs 数
//   ⇒ 索引每增删一批文档，这个标定就**悄悄失效一次**，症状是「召回突然变少」。
//
//   实测经过（2026-11-08）：`index.json` 去重 2288 → 1056 ⇒ 所有词 idf 整体下降
//   ⇒ 相关提问触发从 **15/18 掉到 11/18**，而**代码一行没改**（⑬ 的同进程 A/B 显示四项指标逐字相同）。
//   当时差点把它归因成「⑬ 改坏了检索」，查了半天才发现是数据。
//
//   ⇒ 判据不能靠人记得去看体检表，要变成「红了就说」。
//
// ⚠️ 只在**真实库**上跑：夹具库（test-fixture.mjs）只有几条内容，
//   噪声地板与触发率都没有参考意义 —— 在夹具上断言这条会得到无意义的结论。
// ⚠️ 计算抽在 `hook-threshold.mjs`（唯一实现），与 `recall-eval.mjs` 共用同一份，别各写一遍。
// ============================================================================
import { checkHookThreshold, thresholdProblems, SAFE } from './hook-threshold.mjs';
import { RELATED, IRRELATED } from './eval-cases.mjs';

/**
 * @param {{ok:Function, real:string, hasLocalBank:boolean, skip?:Function}} ctx
 */
export function runThresholdTests({ ok, real, hasLocalBank, skip }) {
  console.log('== 32. hook 阈值标定在安全区内（索引规模变了，阈值会静默失配） ==');
  if (!hasLocalBank) {
    const msg = '本地无 e-2 银行（夹具库数据量不足以标定阈值）';
    if (typeof skip === 'function') skip(msg);
    else console.log('  [SKIP] ' + msg);
    return;
  }
  const t = checkHookThreshold(real, { related: RELATED, irrelated: IRRELATED });
  const probs = thresholdProblems(t);
  ok(probs.length === 0,
    `阈值 ${t.thr}：相关触发 ${t.relatedFired}/${t.relatedTotal}、误触发 ${t.irrFired}/${t.irrTotal}、`
    + `噪声地板 ${t.noiseFloor.toFixed(2)}、余量 ${t.margin.toFixed(2)}×`,
    probs.join('；') + `（安全区：余量 ≥ ${SAFE.MIN_MARGIN}×、相关触发 ≥ 14/18。`
    + `调阈值前先跑 \`node recall-eval.mjs\` 看体检表）`);

  // 防"阈值被调到一个明显荒谬的值"——上面那条只保证"当前是健康的"，
  // 这条保证"有人改这个值时不会改到离谱区间还在绿"（例如手滑写成 0.1 或 30）。
  ok(t.thr > 0 && t.thr <= 5, `阈值 ${t.thr} 落在合理量级（0 < thr ≤ 5；我们的分数范围实测 0.45~8.63）`);
}
