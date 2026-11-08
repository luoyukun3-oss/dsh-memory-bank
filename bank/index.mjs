// ============================================================================
// Memory Bank · index —— 从 bank.mjs 拆出（2026-09-22）
//   ⚠️ 本文件**不许 import bank.mjs**（那会循环依赖）；只依赖 node 标准库 + ./core.mjs + 同层模块。
// ============================================================================
import { ARCHIVED_PAGES, NO_INDEX_PAGES, clip, cutText, isNoIndexPage, nowIso, parseMeta, readJson, readText, tokenize, writeJson } from './core.mjs';
import path from 'node:path';
export const ITEM_PAGES = new Set(['events.md', 'decisions.md', 'lessons.md', 'todos.md', 'inbox.md', 'aliases.md', 'faults.md', 'procedures.md']);

/**
 * 把一节切成若干「条目」（顶级 `- ` 行 + 它的缩进续行）。
 * 2026-09-15 追加：**表格行同样算条目**。`faults.md` 的速查表是"一行一个故障"，
 * 语义和条目页完全一样，只因用的是 `|` 而非 `-`，整张表被当成**一个 758 token 的巨块** ——
 * 密度被稀释，又挨了 `/√len` 和覆盖率因子两刀，实测原始分 6.99 被压到 **0.05**，
 * 输给"记忆里恰好逐字存着这句口语"的流水片段。切行后每条只剩几十 token，密度恢复正常。
 */




export function splitItems(sectionTitle, body) {
  const lines = body.split('\n');
  const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  // 表头行 = 紧挨着分隔行的那一行（`| 症状 | 先查这里 | 结论 |`），它只是列名，不成条目
  const headerIdx = new Set();
  for (let i = 0; i < lines.length - 1; i++) if (isSep(lines[i + 1])) headerIdx.add(i);
  const items = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBullet = /^\s*[-*]\s+\S/.test(line) && !/^\s{2,}/.test(line);
    const isRow = /^\s*\|/.test(line) && !isSep(line) && !headerIdx.has(i);
    // 独立 --- 是结构分隔（细节区起点）：结束当前条目，自身不归属任何条目（否则 recall 片段会带出它）
    if (/^\s*-{3,}\s*$/.test(line)) { if (cur) { items.push(cur); cur = null; } continue; }
    if (isBullet || isRow) {
      if (cur) items.push(cur);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) items.push(cur);
  return items.map((ls) => {
    const raw = ls.join('\n').trim();
    // 表格行：拿**首格**当标题（"DSH 页面卡顿 / 渲染进程 CPU 高"），整行塞进标题会全是噪声
    const cell = ls[0].match(/^\s*\|\s*([^|]+)/);
    const head = cell
      ? cell[1].trim()
      : parseMeta(ls[0]).cleaned.replace(/^\s*[-*]\s+/, '').trim();
    return { title: clip(head, 60) || sectionTitle, text: `${sectionTitle}\n${raw}` };
  });
}

/** 把一个知识页（按 ## 小节切分；条目型页再逐条切分）重新索引进 index.json */




export function reindexPage(dir, pageFile) {
  const abs = path.join(dir, 'pages', pageFile);
  const text = readText(abs);
  if (!text) return 0;
  const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
  // 2026-09-17 修复「时间衰减从未生效」：原先每个 doc 都写 `updated: nowIso()`，记的是**索引时刻**，
  // 于是每次 reindex 都把全库条目的 updated 刷成"现在" ⇒ now−last≈0 ⇒ decay=1 ⇒ **衰减恒等于 1**。
  // （另一路 `access[d.id]` 复述效应也因为 hook 写不进 access.json 而恒为 0 —— 两条来源双双失效。）
  // 现在：**内容逐字未变就沿用旧 updated**（= 该条目首次出现的时刻，或最后一次真正改动），
  // 让 updated 表达"这条多久了"，时间衰减才有意义；内容变了自然刷新。
  const prevById = new Map((idx.docs || []).filter((d) => d.page === pageFile).map((d) => [d.id, d]));
  idx.docs = (idx.docs || []).filter((d) => d.page !== pageFile);
  // 归档页移出检索池（2026-09-15）：不再生成 doc，**物理文件保留**（可 `page` 查看）
  // ⚠️ 2026-09-22 加上 `NO_INDEX_PAGES`（handoff）——**从索引这一步就不入池**。起因是实测：
  //    `cli init` 会把 `pages/` 下所有 .md 都 reindexPage 一遍，于是刚落的 `handoff.md` 进了
  //    index.json，`cli dream` 立刻把它当"知识条目"报出来（`handoff.md#0` 与 inbox 候选撞 88%）。
  //    ⚠️ **别顺手改成 `META_PAGES`**：别名表也在 META_PAGES 里，但它**必须留在索引中**
  //    （显式问"别名表"时要靠它命中）—— 两者语义不同，见 core.mjs 的注释。
  if (ARCHIVED_PAGES.has(pageFile) || isNoIndexPage(pageFile)) {   // isNoIndexPage = 精确集合 ∪ 前缀（days/，2026-10-23）
    idx.updatedAt = nowIso();
    writeJson(path.join(dir, 'index.json'), idx);
    return 0;
  }
  const sections = text.split(/\n(?=##\s)/);
  const useItems = ITEM_PAGES.has(pageFile);
  let n = 0;
  for (const sec of sections) {
    const body = sec.trim();
    if (!body) continue;
    const title = (body.match(/^#{1,6}\s*(.+)$/m) || [, pageFile])[1].trim();
    const items = useItems ? splitItems(title, body) : [];
    const chunks = items.length ? items : [{ title, text: body }];
    const limit = items.length ? 1200 : 1500;
    for (const it of chunks) {
      const { meta, cleaned } = parseMeta(it.text);
      const body2 = cutText(cleaned, limit);
      const old = prevById.get(`${pageFile}#${n}`);
      idx.docs.push({
        id: `${pageFile}#${n}`,
        kind: 'page',
        page: pageFile,
        title: it.title,
        text: body2,
        tokens: tokenize(cleaned),
        ...(Object.keys(meta).length ? { meta } : {}),
        // 内容逐字未变 ⇒ 沿用旧时间戳（保住条目的"年龄"）；变了才算更新
        updated: old && old.text === body2 ? (old.updated || nowIso()) : nowIso(),
      });
      n++;
    }
  }
  idx.updatedAt = nowIso();
  writeJson(path.join(dir, 'index.json'), idx);
  return n;
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
  writeJson(path.join(dir, 'index.json'), idx);
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
  writeJson(path.join(dir, 'index.json'), idx);
  return docs.length;
}
