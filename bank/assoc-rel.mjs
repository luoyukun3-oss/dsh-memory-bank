// ============================================================================
// Memory Bank · assoc-rel —— 联想条目的「与当前查询的相关度」（2026-10-29 按域拆出）
//
// 为什么单独一个文件：assoc.mjs 已 119/120 顶格。按 budgets.json 的 _principle
//   「超限先按域拆出去，**不准靠压缩行宽/合并语句硬塞**」—— 相关度打分是独立职责
//   （输入 query + idfOf，输出 0~1 标量），本来就该独立成模块。
//
// 为什么需要它：拆之前联想分数只由**边的类型**决定（relTyped 0.55 / relPlain 0.52 /
//   cooccur 0.49 / tag 0.47 / hop2 0.46），**与 query 完全无关** ⇒ 同类型永远同分、
//   「按分数排序」实际等于「按类型排序」。实测「河南成考什么时候报名」5 条联想里
//   3 条是噪声，且 5 条分数清一色 0.490，无法区分。
//
// 分数的硬约束（改 REL_W 前必须重跑 test.mjs 第 26 节四条不变量）：
//   ① 最高 0.55 + 0.25 = 0.80 **低于** INJECT_MIN_SCORE(1.5)
//      ⇒ 联想自己永不触发注入，只在主命中已触发时顺带进入
//   ② 最低 0.46 + 0 = 0.46 **高于** recall 的 minScore(0.45) ⇒ 不会被静默过滤
// ============================================================================
import { isNoise, tokenize } from './core.mjs';

/** 相关度最多能贡献多少分。**加法项、不是乘子** —— 乘子会把低分条目压到 0.45 以下被静默丢掉。 */
export const REL_W = 0.25;

/** 造一个 `(doc) => 0~1` 的相关度函数；query 为空或没给 idfOf 时恒返回 0（= 退回纯类型分）。 */
export function makeRelScorer(query, idfOf) {
  const qt = query ? [...new Set(tokenize(query))].filter((t) => !isNoise(t)) : [];
  if (!qt.length || !idfOf) return () => 0;
  return (doc) => {
    const dt = new Set(doc.tokens || []);
    const raw = qt.reduce((s, t) => s + (dt.has(t) ? idfOf(t) : 0), 0);
    return raw / (1 + raw);   // 归一化到 [0,1)：单调递增、永不等于 1
  };
}
