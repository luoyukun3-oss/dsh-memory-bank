// ============================================================================
// Memory Bank · index —— 从 bank.mjs 拆出（2026-09-22）
//   ⚠️ 本文件**不许 import bank.mjs**（那会循环依赖）；只依赖 node 标准库 + ./core.mjs + 同层模块。
//
// 2026-11-08 再拆一次（本文件当时 161/170，只剩 9 行）：**页 → docs 的切分逻辑搬进
//   `index-rebuild.mjs`**，因为批量重建要"先在内存里把所有页建好、最后一次提交"，
//   而切分逻辑本来就是这个动作的一半。拆完本文件只留三个写入口，每个都只转发一行。
//   ⚠️ `ITEM_PAGES` / `splitItems` **仍然从本文件导出**（下面 re-export）——
//      `bank.mjs`、`test-toc.mjs`、`test-fixture.mjs` 都是从 `./index.mjs` 取它们，
//      实现只有一份（在 index-rebuild.mjs），**别在两边各留一份**（assoc.mjs 当年两份实现
//      各跑各的、改一边不生效，就是这条教训）。
// ============================================================================
import path from 'node:path';
import { isNoIndexPage, nowIso, parseMeta, readJson, tokenize } from './core.mjs';
import { commitIndex } from './index-guard.mjs';   // 索引写后自检（2026-11-08，见该文件头）
import { ITEM_PAGES, rebuildIndex, splitItems } from './index-rebuild.mjs';

export { ITEM_PAGES, splitItems, rebuildIndex };

/**
 * 把一个知识页重新索引进 index.json。
 * 2026-11-08 起 = **只重建这一页**的批量重建（同一套"内存构建 + 单次提交"）：
 *   · 失败（文件不存在 / 空页）⇒ 返回 0 且**不落盘** —— 与旧实现一致（旧代码 `if (!text) return 0`
 *     就是什么都不做），也符合「重建失败不能顺手把整页从检索池摘掉」这条。
 *   · 归档页 / handoff / days ⇒ 照旧把旧条目摘出索引，返回 0（有意不入池，不算失败）。
 */
export function reindexPage(dir, pageFile) {
  return rebuildIndex(dir, [pageFile], { maxFailureRatio: 1, state: false }).docsBuilt;
}

/** 追加一条流水/知识文档到索引 */
export function indexDoc(dir, doc) {
  // ⚠️ 2026-10-23：这两个入口原先**没有 guard** —— `reindexPage` 挡住了，`indexDoc/indexDocs` 却直接 push，
  //    于是 `writeDaySplit` 每次 tick 都把 days 页重新塞回索引（实测挡了 reindex 之后仍剩 1 条）。
  //    这正是 handoff 那条教训的第二次复现：**只在 search 里静音，挡不住索引**。
  if (isNoIndexPage(doc && doc.page)) return;
  const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
  idx.docs = (idx.docs || []).filter((d) => d.id !== doc.id);
  idx.docs.push({ ...doc, tokens: tokenize(`${doc.title} ${doc.text}`), updated: nowIso() });
  idx.updatedAt = nowIso();
  commitIndex(dir, idx);   // 2026-11-08：写 + 回读比对 + 条数突变告警（见 index-guard.mjs）
}

/**
 * 批量写索引。2026-09-15 修复：ingest 原先对**每条**用户消息调用一次 indexDoc，
 * 每次都 readJson + filter + writeJson 整个 index.json（O(n²) 磁盘 IO）。
 * 改成先在内存里收集，循环结束写一次。
 */
export function indexDocs(dir, docs) {
  // 同 indexDoc 的 guard（2026-10-23）：批量入口也要挡，否则 days/ 会从这里漏进索引
  docs = (docs || []).filter((d) => !isNoIndexPage(d && d.page));
  if (!docs.length) return 0;
  const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
  const ids = new Set(docs.map((d) => d.id));
  idx.docs = (idx.docs || []).filter((d) => !ids.has(d.id));
  for (const doc of docs) {
    const { meta, cleaned } = parseMeta(doc.text || '');
    idx.docs.push({
      ...doc,
      text: cleaned,
      tokens: tokenize(`${doc.title} ${cleaned}`),
      ...(Object.keys(meta).length ? { meta } : {}),
      updated: nowIso(),
    });
  }
  idx.updatedAt = nowIso();
  commitIndex(dir, idx);   // 2026-11-08：写 + 回读比对 + 条数突变告警（见 index-guard.mjs）
  return docs.length;
}
