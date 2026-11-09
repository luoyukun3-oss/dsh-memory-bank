// ============================================================================
// Memory Bank · index-rebuild —— 批量重建索引的「失败率门 + 不切换」（2026-11-08）
//
// 抄自 LivingMemory `core/validators/index_validator_rebuild.py`：
//     shadow = await self._create_bm25_shadow(table_name)          # 先在影子表上建
//     if self._failure_ratio(len(failed_ids), total) > max_failure_ratio:
//         logger.error("失败率过高，停止后续重建"); break
//     if ratio <= max_failure_ratio: await self._switch_bm25_shadow(...); switched = True
//     finally: if not switched: await self._drop_bm25_shadow(...)   # 没成功 ⇒ 线上一个字节不动
//   它返回 `{processed, errors, failed_ids, switched}`；提交了但仍有失败时标 `partial` 并留名单。
//
// 落到我们这套「md + 文件系统」上的等价物（三条对应关系）：
//   · **影子表 → 内存里的 idx**：所有页先在内存里重建，最后**只调用一次** `commitIndex()`。
//     ⚠️ 刻意**不做磁盘影子文件**：`index.json` 已经 5.7 MB，复制一份既费空间又制造第二份真相；
//        而 `writeJson` 是原子写（core.mjs:46 的 tmp + rename，2026-11-08 已改）⇒
//        **要么旧内容要么新内容，没有中间态**。「不切换」在我们这儿 = 根本不调用 commitIndex
//        —— 比"建好再删影子"更强（连临时文件都不产生）。
//   · **失败率门**：失败页数 / 应建页数 > `maxFailureRatio` ⇒ 中途停止后续页，且**不提交**。
//   · **partial**：提交了但仍有失败页 ⇒ 返回失败名单，并落 `state/index-rebuild.json`（存活历史）。
//
// 四条不能想当然的语义（每条都是"看起来能省、其实会出事"的地方）：
//   ① **跳过 ≠ 失败**：归档页（ARCHIVED_PAGES）与 `isNoIndexPage`（handoff / days/）本来就不进
//      检索池 —— 它们照旧把旧条目从索引里摘掉，但**不记失败、也不进失败率分母**。
//      把它们算成失败，会让 `cli init` 在正常库上报"失败率 20%"（正常库真有归档页）。
//   ② **失败页保留旧条目**，绝不清空：一次解析失败如果顺手把该页从检索池摘掉，那等于用
//      "重建失败"换来"整页记忆消失" —— 比不重建坏得多。
//   ③ **不 reset**：只替换"本次要重建的那些页"的条目。`journal` / `reflection` 这两类 doc 由
//      ingest / reflect 写进来，不归这里管，绝不能顺手清掉（`cli init` 也正是这个口径：它只
//      对 `pages/*.md` 逐个 reindex，从不重建别的页）。⇒ **空页列表是 no-op**，不是"清空索引"。
//   ④ **分母只算"真会被尝试"的页**：`attempted` 在循环前一次算好，不随中途 break 变小 ——
//      否则越早停越显得失败率低，门就形同虚设。
//   ⑤ **`state/index-rebuild.json` 由本模块写、由 index-schema 直接按文件名读**：那边若改成
//      `import { readRebuildState } from './index-rebuild.mjs'` 就会成环
//      （index-schema ← index-guard ← index-rebuild ← index-schema）—— 宁可复制一个文件名，
//      也不制造循环依赖。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import {
  ARCHIVED_PAGES, clip, cutText, isNoIndexPage, nowIso, parseMeta, readJson, readText, tokenize, writeJson,
} from './core.mjs';
import { commitIndex } from './index-guard.mjs';

/** 条目型页面（一行一个事件/决策/教训）—— 从 index.mjs 搬来，**唯一实现在这里**。 */
export const ITEM_PAGES = new Set(['events.md', 'decisions.md', 'lessons.md', 'todos.md', 'inbox.md', 'aliases.md', 'faults.md', 'procedures.md']);

/** 默认失败率上限（LivingMemory 的 `max_failure_ratio`）：20% 以上就不切换。 */
export const MAX_FAILURE_RATIO = 0.2;

// 重建状态文件名（**不导出**：外部要读就用 readRebuildState；index-schema 那边按同一个字面量
// 直接读 —— 它不是 over-export，而是一个刻意复制的文件名，理由见头注释 ⑤）。
const REBUILD_STATE = 'index-rebuild.json';

/**
 * 把一节切成若干「条目」（顶级 `- ` 行 + 它的缩进续行；表格行同样算条目）。
 * 2026-09-15 追加表格行：`faults.md` 的速查表是"一行一个故障"，语义与条目页一样，只因用 `|`
 * 而非 `-`，整张表被当成**一个 758 token 的巨块** —— 密度被稀释、又挨了 `/√len` 和覆盖率两刀，
 * 实测原始分 6.99 被压到 **0.05**，输给"记忆里恰好逐字存着这句口语"的流水片段。
 * ⚠️ 2026-11-08 从 index.mjs **原样搬来**（那边要腾行数预算），index.mjs 仍 re-export 它。
 */
export function splitItems(sectionTitle, body) {
  const lines = body.split('\n');
  const isSep = (l) => /^\s*\|[\s:\|-]+\|\s*$/.test(l);
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

/**
 * 把**一个**知识页解析成 docs（纯计算，不写盘 —— 这是"影子表"的第一步）。
 * 与旧 `reindexPage` 的切分逻辑**逐字一致**（id 编号 `页#n` 也一致，编号漂移会让 access.json 的
 * 复述效应错位，见 lessons 的「页#N 编号漂移」）。
 *
 * @returns {{ok:boolean, reason?:string, docs:Array}} 失败时 docs 为空、reason 说清是哪一类
 */
export function buildPageDocs(dir, pageFile, prevById = new Map()) {
  const abs = path.join(dir, 'pages', pageFile);
  if (!fs.existsSync(abs)) return { ok: false, reason: '文件不存在（pages/ 下没有它）', docs: [] };
  const text = readText(abs);
  if (!text || !text.trim()) return { ok: false, reason: '文件是空的（解析出 0 条目）', docs: [] };
  const sections = text.split(/\n(?=##\s)/);
  const useItems = ITEM_PAGES.has(pageFile);
  const docs = [];
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
      docs.push({
        id: `${pageFile}#${n}`,
        kind: 'page',
        page: pageFile,
        title: it.title,
        text: body2,
        tokens: tokenize(cleaned),
        ...(Object.keys(meta).length ? { meta } : {}),
        // 内容逐字未变 ⇒ 沿用旧时间戳（保住条目的"年龄"）；变了才算更新。
        // ⚠️ 2026-09-17 修过：原先一律写 nowIso() ⇒ updated 恒等于索引时刻 ⇒ 时间衰减恒为 1。
        updated: old && old.text === body2 ? (old.updated || nowIso()) : nowIso(),
      });
      n++;
    }
  }
  if (!docs.length) return { ok: false, reason: '解析出 0 条目（空页或只有标题）', docs: [] };
  return { ok: true, docs };
}

/** `pages/` 下所有 .md（`.bak-*` 备份不以 `.md` 结尾，天然排除；`_bak/` 是目录，也被过滤）。 */
export function listPageFiles(dir) {
  const pd = path.join(dir, 'pages');
  try { return fs.readdirSync(pd).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
}

/** `index.json` 的"指纹"（mtime + size）：只用来判断「有没有被别人动过」，不读内容。 */
function indexStamp(dir) {
  try {
    const s = fs.statSync(path.join(dir, 'index.json'));
    return `${s.mtimeMs}:${s.size}`;
  } catch { return 'missing'; }
}

/** 读最近几次重建的结果（新的在后；坏文件/不存在都返回空数组，绝不抛）。 */
export function readRebuildState(dir, limit = 5) {
  const j = readJson(path.join(dir, 'state', REBUILD_STATE), { items: [] });
  const items = Array.isArray(j.items) ? j.items : [];
  return items.slice(-limit);
}

/** 落盘（保留最近 20 次；失败名单最多存 50 条 —— 别让"记录失败"自己变成大文件）。 */
function saveRebuildState(dir, result) {
  try {
    const f = path.join(dir, 'state', REBUILD_STATE);
    const prev = readJson(f, { items: [] });
    const items = Array.isArray(prev.items) ? prev.items : [];
    const failed = result.failed || [];
    const brief = {
      at: result.at, ok: result.ok, switched: result.switched, partial: result.partial,
      total: result.total, attempted: result.attempted, processed: result.processed, skipped: result.skipped,
      failedCount: failed.length, failedIds: failed.slice(0, 50).map((x) => x.page),
      failed: failed.slice(0, 50), failedTruncated: failed.length > 50,
      failureRatio: result.failureRatio, maxFailureRatio: result.maxFailureRatio,
      docsBefore: result.docsBefore, docsAfter: result.docsAfter,
      stoppedEarly: result.stoppedEarly, reason: result.reason, ms: result.ms,
    };
    items.push(brief);
    writeJson(f, { items: items.slice(-20) });
  } catch { /* 记不上状态也不能拖垮重建本身（同 index-guard 的告警处置） */ }
}

/**
 * 批量重建索引（**唯一会落盘的入口**）。
 *
 * @param {string} dir  仓库目录
 * @param {string[]|null} pages 要重建的页（`null`/`undefined` = pages/ 下全部 .md；`[]` = no-op）
 * @param {{maxFailureRatio?:number, state?:boolean, dryRun?:boolean}} opts
 *   maxFailureRatio 失败率上限（默认 0.2）；state=false 不落状态文件（单页 reindex 用）；
 *   dryRun=true 只算不写（排查用，返回结果里 switched 恒为 false）
 * @returns {{ok:boolean, switched:boolean, partial:boolean, processed:number, skipped:number,
 *   total:number, attempted:number, failed:Array<{page:string,reason:string}>, failedIds:string[],
 *   failureRatio:number, maxFailureRatio:number, docsBefore:number, docsAfter:number,
 *   docsBuilt:number, stoppedEarly:boolean, reason:string, at:string, ms:number}}
 */
export function rebuildIndex(dir, pages = null, { maxFailureRatio = MAX_FAILURE_RATIO, state = true, dryRun = false } = {}) {
  const started = Date.now();
  const list = pages == null ? listPageFiles(dir) : [...pages];
  const base = { at: nowIso(), total: list.length, maxFailureRatio, dryRun };

  // —— 空页列表 = no-op。⚠️ 绝不能推进一个空 docs 的 idx：那是把 5.7 MB 索引一次清空。 ——
  if (!list.length) {
    const r = {
      ...base, ok: true, switched: false, partial: false, attempted: 0, processed: 0, skipped: 0,
      failed: [], failedIds: [], failureRatio: 0, docsBefore: 0, docsAfter: 0, docsBuilt: 0,
      stoppedEarly: false, reason: '页列表为空 ⇒ 什么都不做（线上索引未被触碰）', ms: Date.now() - started,
    };
    if (state) saveRebuildState(dir, r);
    return r;
  }

  const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
  const stamp0 = indexStamp(dir);   // 并发护栏用：读进来时的"指纹"
  const docs0 = Array.isArray(idx.docs) ? idx.docs : [];
  const docsBefore = docs0.length;
  let docs = docs0.slice();   // 内存里的"影子表"
  const failed = [];
  let processed = 0;
  let skipped = 0;
  let docsBuilt = 0;
  let stoppedEarly = false;
  // 分母：只算"真会被尝试"的页（归档/handoff/days 有意不建 ⇒ 不算，见头注释 ①）
  const attempted = list.filter((p) => !ARCHIVED_PAGES.has(p) && !isNoIndexPage(p)).length;

  for (const pageFile of list) {
    // ① 有意不入池的页：照旧把它的旧条目摘掉（保持 reindexPage 的原行为），但不记失败
    if (ARCHIVED_PAGES.has(pageFile) || isNoIndexPage(pageFile)) {
      docs = docs.filter((d) => d.page !== pageFile);
      skipped++;
      continue;
    }
    const prevById = new Map(docs.filter((d) => d.page === pageFile).map((d) => [d.id, d]));
    let built;
    try {
      built = buildPageDocs(dir, pageFile, prevById);
    } catch (e) {
      built = { ok: false, reason: `解析抛错（${e.message}）`, docs: [] };
    }
    if (!built.ok) {
      failed.push({ page: pageFile, reason: built.reason });
      // ② 失败页**保留旧条目**（docs 里那页原样不动）；失败率过高则立刻停手（照抄 break）
      if (attempted && failed.length / attempted > maxFailureRatio) { stoppedEarly = true; break; }
      continue;
    }
    docs = docs.filter((d) => d.page !== pageFile);   // 替换该页（其余页原样保留，见头注释 ③）
    docs.push(...built.docs);
    docsBuilt += built.docs.length;
    processed++;
  }

  const failureRatio = attempted ? failed.length / attempted : 0;
  let blocked = stoppedEarly || failureRatio > maxFailureRatio;
  const changed = processed > 0 || skipped > 0;
  // 并发护栏（2026-11-08）：本函数把"每页一次小提交"合成"一次大提交"，中间窗口从毫秒级变成
  //   百毫秒级（真实库实测 164 ms）⇒ 若期间别的进程（tick / hook / 另一个 cli）写过 index.json，
  //   这次整体覆盖会**静默吞掉**它刚写进去的东西。判据：读时的 mtime+size 与提交前是否一致。
  //   ⚠️ 这一支是**防御性代码，没有单测**：函数是同步的，窗口里插不进外部写（同
  //      test-index-guard.mjs 头注释对"回读比对"那支的处理 —— 不假装测过了）。
  const stampMoved = !dryRun && changed && !blocked && indexStamp(dir) !== stamp0;
  if (stampMoved) blocked = true;
  let switched = false;
  let docsAfter = docsBefore;
  if (!blocked && changed && !dryRun) {
    idx.docs = docs;
    idx.updatedAt = nowIso();
    docsAfter = commitIndex(dir, idx);   // ← 唯一一次落盘（原子写 + 回读比对 + 突变告警）
    switched = true;
  }
  const reason = stampMoved
    ? '重建期间 index.json 被别的进程改过 ⇒ 本次放弃提交（重跑即可），线上保持对方写入的版本'
    : blocked
      ? `失败率 ${(failureRatio * 100).toFixed(0)}% 超过上限 ${(maxFailureRatio * 100).toFixed(0)}%${stoppedEarly ? '，中途停止' : ''} ⇒ 不提交，线上索引未动`
      : dryRun ? '预演（dryRun）⇒ 未落盘'
        : !changed ? '没有可提交的变更（本次没有成功重建的页）'
          : failed.length ? `已提交，但 ${failed.length} 页失败（失败页保留旧条目）` : '全部成功';
  const result = {
    ...base, ok: switched || (dryRun && !blocked), switched, partial: switched && failed.length > 0,
    attempted, processed, skipped, failed, failedIds: failed.map((x) => x.page), failureRatio,
    docsBefore, docsAfter, docsBuilt, stoppedEarly, stampMoved, reason, ms: Date.now() - started,
  };
  if (state) saveRebuildState(dir, result);
  return result;
}
