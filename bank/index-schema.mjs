// ============================================================================
// Memory Bank · index-schema —— 索引的结构版本与自描述（2026-11-08）
//
// 要解决的问题（调研指出的、也是今天两起事故的共同根）：
//   `index.json` 是**全库最大的落盘物**（5.7 MB），顶层却只有 `docs` + `updatedAt`。
//   于是有两件事判不出来：
//     ① **「我读到的是哪一版」** —— 结构演进后，老代码会把新索引当自己的用、新代码会把老索引当完整的用。
//     ② **「这份索引是不是完整的」** —— docs 数从 2288 悄悄掉到 1056，文件本身长得完全正常，
//        没有任何自描述字段能跟"它应该有这么多条"对照。
//
// 抄自 `storage/db_migration.py` 的四路指纹判别，但只抄骨架、参数按我们的域定：
//   · 它靠「有没有版本表 / 有数据无表 / 空表 / 全空」四种探测各给一支处理路径
//   · 它的一条纪律：**判不准就倒向最旧**（宁可当老版本处理，也不猜）
//   · 它的另一条：**转不动就只打标记**（不自动迁移）
// ⇒ 我们对应：**版本号 + stats 自描述 + 只报不迁移**。
//
// ⚠️ 为什么不自动迁移：`index.json` 可以从 `pages/*.md` **完全重建**（`cli init` / `reindexPage`），
//   所以"迁移旧索引"这件事本身没有价值 —— 重建更安全。**不能重建的才需要迁移，而它不是。**
// ⚠️ 为什么不改 50 多个读取点：加字段对老代码无害（它们只读 `docs`）。
//   校验放在"定期体检"里（`verifyIndex`）而不是每次读 —— 否则每次 recall 都要多算一遍。
// ============================================================================
import path from 'node:path';
import { readJson } from './core.mjs';

/**
 * 当前代码认识的索引结构版本。
 * 加它/改 `docs` 里字段形状时**必须** +1，并在 `verifyIndex` 的迁移提示里写明怎么重建。
 * 版本历史：
 *   1（2026-11-08）首次引入：docs[{id,page,kind,title,text,tokens,updated,meta?}] + stats
 */
export const INDEX_SCHEMA_VERSION = 1;

/** 打标：写入前给索引补上 `schemaVersion` 与 `stats` 自描述。 */
export function stampIndex(idx) {
  const docs = Array.isArray(idx.docs) ? idx.docs : [];
  const byPage = {};
  for (const d of docs) {
    const p = d && d.page ? d.page : '(无页)';
    byPage[p] = (byPage[p] || 0) + 1;
  }
  return {
    ...idx,
    schemaVersion: INDEX_SCHEMA_VERSION,
    stats: { docs: docs.length, pages: Object.keys(byPage).length, byPage },
  };
}

/**
 * 校验索引的结构健康度。**只报不修**。
 * @returns {{ok:boolean, problems:string[], version:number|null, docs:number}}
 */
export function verifyIndex(dir) {
  const f = path.join(dir, 'index.json');
  const j = readJson(f, null);
  const problems = [];
  if (!j || typeof j !== 'object') {
    return { ok: false, problems: [`索引读不回来或不是合法 JSON：${f}`], version: null, docs: 0 };
  }
  const docs = Array.isArray(j.docs) ? j.docs : null;
  if (!docs) {
    problems.push('缺少 docs 数组 —— 文件结构不对');
    return { ok: false, problems, version: j.schemaVersion ?? null, docs: 0 };
  }

  // ① 版本判别（判不准就倒向"旧"，不猜成新的）
  const v = typeof j.schemaVersion === 'number' ? j.schemaVersion : null;
  if (v === null) {
    problems.push(`没有 schemaVersion（2026-11-08 之前写的索引）⇒ 重建一遍即可：\`cli init\``);
  } else if (v > INDEX_SCHEMA_VERSION) {
    problems.push(`索引版本 ${v} 比代码认识的 ${INDEX_SCHEMA_VERSION} 新 —— 可能是更新版本的程序写的，**别用老代码覆盖它**（先升级代码）`);
  } else if (v < INDEX_SCHEMA_VERSION) {
    problems.push(`索引版本 ${v} 旧于当前 ${INDEX_SCHEMA_VERSION} ⇒ 重建（索引可从 pages/*.md 完全重建，不需要迁移）`);
  }

  // ② 自描述与实际对照 —— 这条抓「文件被外部改过 / 写了一半」
  if (j.stats && typeof j.stats.docs === 'number' && j.stats.docs !== docs.length) {
    problems.push(`stats.docs=${j.stats.docs} 与实际 ${docs.length} 条不符 —— 索引被外部改过，或写入不完整`);
  }
  // 每页条数对照：只报"变少了"的页（多出来是正常的，新写条目就会多）
  if (j.stats && j.stats.byPage) {
    const now = {};
    for (const d of docs) if (d && d.page) now[d.page] = (now[d.page] || 0) + 1;
    const shrunk = Object.entries(j.stats.byPage)
      .filter(([p, n]) => typeof n === 'number' && n >= 5 && (now[p] || 0) < n)
      .map(([p, n]) => `${p} ${n}→${now[p] || 0}`);
    if (shrunk.length) problems.push(`这些页的条目变少了：${shrunk.slice(0, 6).join('、')}${shrunk.length > 6 ? ` 等 ${shrunk.length} 页` : ''}`);
  }

  // ③ 必填字段抽查（只抽前 200 条，够发现系统性缺失）
  const bad = docs.slice(0, 200).filter((d) => !d || !d.id || !d.page || !Array.isArray(d.tokens));
  if (bad.length) problems.push(`前 200 条里有 ${bad.length} 条缺 id/page/tokens —— 索引结构不对`);

  return { ok: problems.length === 0, problems, version: v, docs: docs.length };
}

// —— 2026-11-09 按域拆（本文件当时 118/120 顶格）：「一行摘要」这一层搬到 `index-status.mjs` ——
//   它只做**展示**（把 verifyIndex 的结果压成一行给 `cli status`），与「结构版本 / 打标 / 校验」是两件事。
//   ⇒ 依赖方向**单向**：index-status → index-schema。这里 re-export 只为保住调用方 import 路径：
//     `bank/cli.mjs`、`bank/test-index-rebuild.mjs` 仍从 `./index-schema.mjs` 取 indexStatusLine。
//   ⚠️ 反向（从这里 import index-status）会立刻成环 —— 别这么写。
export { indexStatusLine } from './index-status.mjs';
