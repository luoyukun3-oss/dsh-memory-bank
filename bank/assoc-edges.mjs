// ============================================================================
// Memory Bank · assoc-edges —— 联想的「邻接候选从哪来」（2026-11-09 按域拆出）
//
// 为什么单独一个文件：`assoc.mjs` 实测 117/120 行（98%，下一条就爆）。
//   按 budgets.json 的 `_principle`「只许瘦不许胖：超限先按域拆分，别压缩行宽硬塞」处理。
//
// 分工（按**「取候选」vs「给分与名额」**切，不是按行数硬切）：
//   · 本文件 = **四类邻接关系的查询**：rel 边（页+关键词定位）、共现、同标签、2 跳。
//     全部是「从 docs / cooccur.json 里找出谁跟 top 相邻」，**不打分、不截断**；
//   · `assoc.mjs` = **分数表 W、名额 TOTAL/HOP2_MAX/ZERO_KEEP、投池 offer、排序与截断**。
//   ⇒ 依赖方向单向：assoc → assoc-edges（edges **不 import assoc**，否则成环）。
//
// ⚠️ **顺序即行为**：`assoc.mjs` 是「先到先得 + 同 id 保留高分」，等分时先投的那条留下。
//   所以四个函数返回的数组顺序必须与原实现逐字一致（rel 走 rankRelTargets 的排序结果、
//   共现走 top × Object.entries、标签走 docs 原序、2 跳走 typedDocs 原序）—— 别在这里改顺序。
// ============================================================================
import path from 'node:path';
import { rankRelTargets, readJson } from './core.mjs';

/** rel 边用「页 + 关键词」定位（编号会漂，见 lessons 的「页#N 编号漂移」）。 */
export function findRel(docs, seed, page, key) {
  return docs.find((d) => d.page === page && !seed.has(d.id)
    && ((d.title || '').includes(key) || (d.text || '').includes(key)));
}

/** ① rel 边（1 跳）：人工判断过的边，最可信。
 *  @returns {Array<{doc:object, type:string|null, relKey:string}>} 顺序 = rankRelTargets(全部 top 的边) */
export function relCandidates(top, docs, seed) {
  const relTargets = [];
  for (const h of top) for (const r of (h.meta?.rel || [])) relTargets.push(r);
  const out = [];
  for (const t of rankRelTargets(relTargets)) {
    const d = findRel(docs, seed, t.page, t.key);
    if (!d) continue;
    out.push({ doc: d, type: t.type || null, relKey: `${t.page}:${t.key}` });
  }
  return out;
}

/** ② 共现（1 跳）：行为证据——这两条实际在同一轮里被一起命中过（只同现过一次不算）。
 *  @returns {Array<{doc:object, coCount:number}>} 顺序 = top 顺序 × cooccur 表内的键顺序 */
export function cooccurTargets(top, dir, docs) {
  const co = readJson(path.join(dir, 'cooccur.json'), {});
  const out = [];
  for (const h of top) {
    for (const [oid, n] of Object.entries(co[h.id] || {})) {
      if (n < 2) continue;
      const d = docs.find((x) => x.id === oid);
      if (!d) continue;
      out.push({ doc: d, coCount: n });
    }
  }
  return out;
}

/** ③ 同标签（1 跳）：静态主题，最弱的一档，但不怕共现数据冷启动。
 *  @returns {Array<{doc:object, sharedTags:string[]}>} 顺序 = docs 原序 */
export function tagTargets(top, docs) {
  const hitTags = new Set();
  for (const h of top) for (const tg of (h.meta?.tags || [])) hitTags.add(tg);
  if (!hitTags.size) return [];
  const out = [];
  for (const d of docs) {
    const shared = ((d.meta?.tags) || []).filter((tg) => hitTags.has(tg));
    if (shared.length) out.push({ doc: d, sharedTags: shared });
  }
  return out;
}

/** ④ 2 跳：从「带类型的 rel 目标」再走一跳带类型的 rel（只走带类型的边 —— 2 跳本来就容易飞）。
 *  @param {object[]} typedDocs ①里带类型的那些目标，顺序即出发顺序
 *  @returns {Array<{from:object, doc:object, next:object}>} 顺序 = typedDocs 原序 */
export function hop2Targets(typedDocs, docs, seed) {
  const out = [];
  for (const d of typedDocs) {
    const next = (d.meta?.rel || []).find((r) => r.type && findRel(docs, seed, r.page, r.key));
    if (!next) continue;
    out.push({ from: d, doc: findRel(docs, seed, next.page, next.key), next });
  }
  return out;
}
