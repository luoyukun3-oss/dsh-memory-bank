// ============================================================================
// Memory Bank · assoc —— 「主命中之后的联想」（2026-10-27 改成扩散式）
//
// ⚠️ 历史坑（2026-10-27 查实）：本文件 2026-09-30 从 search.mjs 按域拆出，但**拆完
//    search.mjs 里还留着一份逐字相同的内联副本**，于是 `appendAssociations` 长期是
//    **零调用方**（外部零引用、也没人 import）—— 两份实现各跑各的，改这里不生效。
//    2026-10-27 收拢：**本文件是唯一实现**，search.mjs 只保留一行调用。
//    教训同族：MIN_SCORE 曾经各抄一份导致漂移（见 config-keys.mjs 头注释）。
//
// 旧行为：三类各 2 个名额、分数写死（标签 0.50 / rel 0.55 / 共现 0.52），先到先得
//         ⇒ 那是「检索」，只会从主命中往外够一跳。
//
// 新行为：**一个候选池，按「边权 + 跳数」排序，总共取 5 条**：
//   1 跳 rel（带类型）            0.55  ← 人工判断过语义，最可信
//   1 跳 rel（无类型）            0.52
//   1 跳共现（同一轮一起命中 ≥2） 0.49  ← 行为证据
//   1 跳同标签                    0.47
//   2 跳（只走带类型的 rel）       0.46  ← 「开枝散叶」那一层，全局最多 1 条
//
// ⚠️ 2026-10-27 建完当场实测：全库 rel 边里**带类型的只有 18 条**（无类型 93 条），
//    **可用的 2 跳链（A→B→C 且两段都带类型）= 0 条** ⇒ 这层代码现在**空转、不产生任何条目**。
//    留着是因为逻辑验证过（有链就会跑），但**别以为它已经在工作** —— 这正是
//    「代码在跑 ≠ 这件事在做」那个坑（lessons H 节 2026-10-18 条）。
//    要让它真生效，得先把建边时的类型标注补上（`rel-apply` 支持 :type）。
//
// ⚠️ 全部**低于 hook 的 INJECT_MIN_SCORE(1.5)** ⇒ 联想自己永不触发注入，
//    只在主命中已触发时顺带进入那段文本 —— 这条铁律不变。
// ⚠️ 全部**高于 recall 的 minScore(0.45)** ⇒ 不会被静默过滤掉（0.46 是下限，别再往下压）。
// ⚠️ 2 跳必须单独设上限（HOP2_MAX）：不限的话噪声指数级涨，收益跟不上。
// ============================================================================
import path from 'node:path';
import { rankRelTargets, readJson } from './core.mjs';
import { REL_W, makeRelScorer } from './assoc-rel.mjs';

const W = {
  relTyped: 0.55,
  relPlain: 0.52,
  cooccur: 0.49,
  tag: 0.47,
  hop2: 0.46,
};
const TOTAL = 5;        // 总名额（旧版是 2+2+2，最多 6）
const HOP2_MAX = 1;     // 2 跳最多几条（2 跳本来就容易飞，边没判过语义就没法看）
const ZERO_KEEP = 2;    // 全零相关时最多留几条 —— 不硬凑满 TOTAL，宁可少给也不塞噪声

/** 就地把联想条目追加到 `top` 末尾（联想不参与排序，只接在后面）。 */
export function appendAssociations(top, docs, dir, query = '', idfOf = null) {
  const seed = new Set(top.map((h) => h.id));
  const pool = new Map();   // id -> { doc, score, via, extra }
  // 联想分数 = 边的类型分 + REL_W × 与 query 的相关度（相关度打分见 assoc-rel.mjs，2026-10-29 按域拆出）。
  const relOf = makeRelScorer(query, idfOf);

  /** 投候选进池：已命中过的跳过、低置信/已被取代的跳过、同 id 保留分高的。 */
  const offer = (doc, base, via, extra = {}) => {
    if (!doc || seed.has(doc.id)) return;
    const m = doc.meta || {};
    if (m.confidence === 'low' || m.supersededBy) return;
    const rel = relOf(doc), score = base + REL_W * rel;
    const prev = pool.get(doc.id);
    if (prev && prev.score >= score) return;
    pool.set(doc.id, { doc, score, via, extra, rel });
  };

  /** rel 边用「页 + 关键词」定位（编号会漂，见 lessons 的「页#N 编号漂移」）。 */
  const findRel = (page, key) => docs.find((d) => d.page === page && !seed.has(d.id)
    && ((d.title || '').includes(key) || (d.text || '').includes(key)));

  // —— ① rel 边（1 跳）——人工判断过的边，优先占名额
  const relTargets = [];
  for (const h of top) for (const r of (h.meta?.rel || [])) relTargets.push(r);
  const typedDocs = [];   // 带类型的 rel 目标 = 2 跳的出发点
  for (const t of rankRelTargets(relTargets)) {
    const d = findRel(t.page, t.key);
    if (!d) continue;
    offer(d, t.type ? W.relTyped : W.relPlain, 'rel',
      { relKey: `${t.page}:${t.key}`, relType: t.type || null });
    if (t.type) typedDocs.push(d);
  }

  // —— ② 共现（1 跳）——行为证据：这两条实际在同一轮里被一起命中过
  const co = readJson(path.join(dir, 'cooccur.json'), {});
  for (const h of top) {
    for (const [oid, n] of Object.entries(co[h.id] || {})) {
      if (n < 2) continue;   // 只同现过一次不算（可能是巧合）
      offer(docs.find((d) => d.id === oid), W.cooccur, 'cooccur', { coCount: n });
    }
  }

  // —— ③ 同标签（1 跳）——静态主题，最弱的一档，但不怕共现数据冷启动
  const hitTags = new Set();
  for (const h of top) for (const tg of (h.meta?.tags || [])) hitTags.add(tg);
  if (hitTags.size) {
    for (const d of docs) {
      const shared = ((d.meta?.tags) || []).filter((tg) => hitTags.has(tg));
      if (shared.length) offer(d, W.tag, 'tag', { sharedTags: shared });
    }
  }

  // —— ④ 2 跳（2026-10-27 新增）：从「带类型的 rel 目标」再走一跳带类型的 rel。
  //    只走带类型的边 —— 2 跳本来就容易飞，边再没判过语义就没法看了。
  let hop2Used = 0;
  for (const d of typedDocs) {
    if (hop2Used >= HOP2_MAX) break;
    const next = (d.meta?.rel || []).find((r) => r.type && findRel(r.page, r.key));
    if (!next) continue;
    offer(findRel(next.page, next.key), W.hop2, 'rel2',
      { relKey: `${next.page}:${next.key}`, relType: next.type, via2: d.id });
    hop2Used += 1;
  }

  // —— ⑤ 排序 + 断崖截断（2026-10-29）：池里有「与 query 相关」的候选就只取它们；全零相关时最多留 ZERO_KEEP 条，不硬凑满。
  const sorted = [...pool.values()]
    .sort((a, b) => (b.score - a.score) || ((b.extra?.coCount || 0) - (a.extra?.coCount || 0)));
  const anyRel = sorted.some((p) => p.rel > 0);
  const picked = (anyRel ? sorted.filter((p) => p.rel > 0) : sorted.slice(0, ZERO_KEEP)).slice(0, TOTAL);
  for (const p of picked) top.push({ ...p.doc, score: p.score, via: p.via, ...p.extra });
}
