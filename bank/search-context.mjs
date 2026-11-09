// ============================================================================
// Memory Bank · search-context —— 检索索引的「预载上下文」（2026-11-09）
//
// 为什么需要：`search()` 每次被调用都会 `readJson(index.json)`（实测 5.53 MB / **57 ms**）
//   再遍历全部 docs 重建 df（**75 ms**）⇒ **每次 132 ms，与查询词完全无关**。
//   `reflect()` 第五节按主题逐个搜（实测 10 次）⇒ 1.3 s 全花在重复读盘建表上。
//   把这三步（读盘 / 过滤归档与元页 / 建 df）搬到这里，调用方可读一次、传多次：
//       const ctx = buildSearchContext(dir);
//       search(dir, '甲', 20, ctx); search(dir, '乙', 20, ctx); …
//   ⚠️ 不传 ctx 时 `search()` 行为与改前**逐字相同**（内部照样现读一盘）。默认路径不变
//      是这套改动的底线：`search()` 在 hook 每轮召回的热路径上。
//
// ⚠️ 为什么必须存**两套**（plain / meta）：`search()` 里 docs 的过滤**依赖查询词**——
//   `wantMeta = /别名|同义|术语表|alias/i.test(query)` 命中就把 META_PAGES 放行，
//   而 df 是在**过滤后的 docs** 上建的 ⇒ 两套的 df 不同（元页那几条的 token 计数差）。
//   预载时若只算一套，另一次调用就会用到错的 df = 分数悄悄变了，是最难查的一类 bug。
//
// ⚠️ meta 那套**懒算**（getter），不跟 plain 一起算：实测两套都算 146 ms、只算 plain 107 ms，
//   而 `wantMeta` 只在查询词含「别名/同义/术语表/alias」时才为真（reflect 那 10 次全都不是）。
//   懒算 ⇒ 常见批量查询省 39 ms；真用到时照样算得出来（首次访问后缓存在闭包里）。
//   ⚠️ 试过"先算 meta.df、再减掉元页贡献得到 plain.df"——也能省一次遍历，但要多一次 Map 复制
//   和一段容易写错的减法。现在直接算 plain 更简单，结果完全一样（df 只依赖那套 docs）。
// ============================================================================
import path from 'node:path';
import { ARCHIVED_PAGES, META_PAGES, readJson } from './core.mjs';

/** 与 search.mjs 里**逐字一致**的 df 口径：每条 doc 的 tokens 去重后计数。 */
const dfOf = (list) => {
  const df = new Map();
  for (const d of list) for (const t of new Set(d.tokens || [])) df.set(t, (df.get(t) || 0) + 1);
  return df;
};

/**
 * 预载一份检索上下文。
 * @param {string} dir 仓库目录
 * @returns {{plain:{docs:Array,df:Map,N:number}, meta:{docs:Array,df:Map,N:number}}}
 *   `plain` = 不放行元页（`wantMeta` 为 false，默认）；`meta` = 放行元页
 */
export function buildSearchContext(dir) {
  const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
  const base = (idx.docs || []).filter((d) => !ARCHIVED_PAGES.has(d.page));
  const plain = base.filter((d) => !META_PAGES.has(d.page));
  let meta = null;
  return {
    plain: { docs: plain, df: dfOf(plain), N: plain.length },
    // meta 那套**懒算**（2026-11-09，实测）：两套都算 146 ms，只算 plain 107 ms —— 因为
    // `wantMeta` 只在查询词含「别名/同义/术语表/alias」时才为真（reflect 那 10 次全都不是）。
    // 懒算 ⇒ 常见的批量查询省 39 ms，而万一真用到，照样算得出来（第一次访问后缓存）。
    get meta() {
      if (!meta) meta = { docs: base, df: dfOf(base), N: base.length };
      return meta;
    },
  };
}
