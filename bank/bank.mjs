// ============================================================================
// Memory Bank —— 会学习的长期记忆引擎（零依赖，纯 Node 标准库）
//   · 按仓库隔离：bank/repos/<slug>/
//   · 自动召回：关键词倒排 + idf 打分（中文用二元组、英文按词）
//   · 知识页：pages/*.md（可读、可手改）
//   · 深度反思：reflections/*.md + lessons 候选
//   · 流水记录：journal/YYYY-MM-DD.md（从会话日志增量抽取）
// 用法：node bank.mjs <init|remember|recall|ingest|reflect|status|page|migrate> [...]
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { INJECT_BUDGET } from './config-keys.mjs';

import {
  HERE, BANK, ROOT, REPOS, GLOBAL_SLUG, nowIso, zh, day, readJson, writeJson, writeText, readText, clip, isNoIndexPage, META_KEYS, META_SOURCES, META_CONFS, REL_TYPES, rankRelTargets, parseMeta, ARCHIVED_PAGES, META_PAGES, aliasCache, loadAliases, loadAccess, bumpAccess, slugOf, repoDir, ensureRepo, tokenize, MAGIC, decompressAll, readRecords, textOf, findTranscripts, fingerprint, STOP, isNoise, lineToText, cutText, stripFirstHeading, splitSections, SYNC_MAP, lineSet, lineDiff, pageBlocks,
} from './core.mjs';
export { zh, day, readJson, writeJson, writeText, readText, clip, rankRelTargets, parseMeta, ARCHIVED_PAGES, META_PAGES, loadAliases, loadAccess, bumpAccess, slugOf, repoDir, ensureRepo, tokenize, decompressAll, readRecords, findTranscripts, fingerprint, isNoise, cutText, stripFirstHeading, splitSections, lineDiff } from './core.mjs';   // 对外接口不变（调用方零改动）
import {
  search, searchDetailed, recall,
} from './search.mjs';
export { search, searchDetailed, recall } from './search.mjs';   // searchDetailed = 09-30 新增的"理由层"入口
import {
  indexList, lessonIndex, bootstrapText,
} from './bootstrap.mjs';
export { indexList, lessonIndex, bootstrapText } from './bootstrap.mjs';   // 对外接口不变（调用方零改动）
import {
  ITEM_PAGES, splitItems, reindexPage, indexDoc, indexDocs,
} from './index.mjs';
export { reindexPage, indexDoc, indexDocs } from './index.mjs';   // 对外接口不变（调用方零改动）
// ---------------------------------------------------------------- 摄入（保存）
// 2026-09-15 修复：原规则太宽（"安装"「版本」"报错"任一个词就落盘），把知识页灌成了垃圾场
//   —— environment.md 曾被追加 20+ 条（"帮我安装一下"、Traceback 原文…），lessons.md 同理。
//   现在要求：必须同时具备「具体信息」或「报错+原因/修复」才算数。
import {
  HEUR, INBOX_GATE, scoreCandidate, ingest,
} from './ingest.mjs';
export { INBOX_GATE, scoreCandidate, ingest } from './ingest.mjs';   // 对外接口不变（调用方零改动）
import {
  reflect,
} from './reflect.mjs';
export { reflect } from './reflect.mjs';   // 对外接口不变（调用方零改动）
export function checkLineBudgets(memRoot) {
  const table = readJson(path.join(memRoot, 'bank', 'budgets.json'), { budgets: {} });
  const budgets = table.budgets || {};
  const rows = [];
  for (const [rel, budget] of Object.entries(budgets)) {
    const f = path.join(memRoot, rel);
    if (!fs.existsSync(f)) {
      rows.push({ file: rel, budget, lines: null, over: false, missing: true, pct: 0 });
      continue;
    }
    // 行数口径：先去掉末尾换行再切分 —— 否则「以换行结尾」的文件会白多算一行
    const text = fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '');
    const lines = text.split(/\r?\n/).length;
    rows.push({
      file: rel,
      budget,
      lines,
      over: lines > budget,
      missing: false,
      pct: Math.round((lines / budget) * 100),
    });
  }
  return { rows, over: rows.filter((r) => r.over), table };
}









export function syncFromMemory(dir, { memoryFile = 'E:/2/_dsh_memory/MEMORY.md', apply = false, from = 'memory', withDiff = false, only = null } = {}) {
  let memText = readText(memoryFile);
  if (!memText.trim()) return { ok: false, report: [], drift: 0, reason: 'no-memory-file' };
  let memBackedUp = false;
  const report = [];
  // 2026-10-29：MEMORY.md 全 CRLF（510 行）、四个知识页全 LF ⇒ 比较前必须先归一化成 LF，
  // 否则 have === want 永远为假（诊断见 E:\2\记忆库体检-2026-10-29.md 第一节）。
  // 写入时再跟随目标文件自身行尾，否则 --apply 两个方向都会制造混合行尾。
  const eolOf = (t) => {
    const crlf = (t.match(/\r\n/g) || []).length;
    const lf = (t.match(/\n/g) || []).length - crlf;
    return crlf > lf ? '\r\n' : '\n';
  };
  const toEol = (t, eol) => t.replace(/\r\n/g, '\n').replace(/\n/g, eol);

  for (const [key, page] of SYNC_MAP) {
    if (only && !only.includes(page)) continue;   // 2026-09-21：三处漂移方向不同 ⇒ 允许一次只处理指定页
    const ms = splitSections(memText).find((s) => s.title.includes(key));
    if (!ms) { report.push({ page, section: key, status: 'memory-missing' }); continue; }
    const pf = path.join(dir, 'pages', page);
    const pageText = readText(pf);
    const ps = splitSections(pageText).find((s) => s.title.includes(key));
    const want = ms.body.replace(/\r\n/g, '\n').trim();
    const have = ps ? ps.body.replace(/\r\n/g, '\n').trim() : null;
    const info = { page, section: key, chars: want.length, pageChars: have === null ? 0 : have.length };
    if (have !== null) {
      const d = lineDiff(want, have);
      info.memoryOnly = d.memoryOnly;
      info.pageOnly = d.pageOnly;
    }
    if (have === want) { report.push({ ...info, status: 'in-sync' }); continue; }
    if (!apply) { report.push({ ...info, status: have === null ? 'missing-in-page' : 'differs' }); continue; }

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    if (from === 'page') {
      // 页面 → MEMORY.md（页面更细时用）
      if (have === null) { report.push({ ...info, status: 'page-missing' }); continue; }
      if (!memBackedUp) { writeText(`${memoryFile}.bak-${stamp}`, memText); memBackedUp = true; }
      // ⚠️ splitSections 按 \n 切行 ⇒ 在 CRLF 文本上算出的 raw 会以「孤立 \r」结尾，
      // 直接 replace 会吃掉下一个空行的 \r（实测 MEMORY.md 510 CRLF → 509 CRLF + 1 裸 LF）。
      // ⇒ 统一先全转 LF 再操作，最后再转回目标行尾。
      const eol = eolOf(memText);
      const lfb = memText.replace(/\r\n/g, '\n');
      const cur = splitSections(lfb).find((s) => s.title.includes(key));
      memText = toEol(lfb.replace(cur.raw, () => `## ${cur.title}\n${have}\n`), eol);
      writeText(memoryFile, memText);
      report.push({ ...info, status: 'memory-updated' });
    } else {
      // MEMORY.md → 页面（默认方向）
      if (have !== null) writeText(`${pf}.bak-${stamp}`, pageText);
      const eol = eolOf(pageText);  // 知识页全 LF ⇒ 不能把 MEMORY 的 \r 带进来
      const lfp = pageText.replace(/\r\n/g, '\n');
      const psp = ps ? splitSections(lfp).find((s) => s.title.includes(key)) : null;
      const out = toEol(psp
        ? lfp.replace(psp.raw, () => `## ${psp.title}\n${want}\n`)
        : lfp.replace(/\s+$/, '') + `\n\n## ${ms.title}\n${want}\n`, eol);
      writeText(pf, out);
      reindexPage(dir, page);
      report.push({ ...info, status: have === null ? 'inserted' : 'updated' });
    }
  }
  const drift = report.filter((r) => r.status !== 'in-sync').length;
  if (withDiff) return { ok: true, report, drift, verbose: true };
  return { ok: true, report: report.map(({ memoryOnly, pageOnly, ...r }) => r), drift };
}







// ---------------------------------------------------------------- 定期维护
// 把已完成项归档到 todos-archive.md、去掉重复条目、压缩空行，让注入索引保持干净
export function tidyRepo(dir) {
  const f = path.join(dir, 'pages', 'todos.md');
  const before = readText(f);
  if (!before.trim()) return { skipped: true };
  const seen = new Set();
  const keep = [];
  const moved = [];
  let carrying = false;   // 上一条已完成 → 它的缩进续行跟着一起搬
  for (const line of before.replace(/\r\n/g, '\n').split('\n')) {
    const isDone = /^\s*[-*]\s*\[[xX]\]/.test(line);
    const isItem = /^\s*[-*]\s+\[[ xX]\]/.test(line);
    if (isDone) {
      moved.push(line.trim());
      carrying = true;
      continue;
    }
    if (carrying) {
      // 2026-09-15 修复：原先只搬首行，缩进续行留在 todos.md 变成孤儿文本
      if (/^\s+\S/.test(line) && !isItem) { moved.push(line.replace(/^\s+/, '  ').trimEnd()); continue; }
      carrying = false;
    }
    const key = line.trim();
    if (isItem) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    keep.push(line);
  }
  const body = keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '') + '\n';
  writeText(f, body);
  reindexPage(dir, 'todos.md');

  if (moved.length) {
    const af = path.join(dir, 'pages', 'todos-archive.md');
    const head = readText(af) || '# 已完成归档\n\n> 由 `cli.mjs tidy` 自动归档；不再参与会话开场注入，需要时可 `page todos-archive.md` 查阅。\n';
    const clean = head.replace(/\s+$/, '');
    const today = `## ${day()}`;
    // 续行保持缩进形式（不加 `- ` 前缀），这样在 Markdown 里仍是上一项的子行
    const items = moved.map((l) => (l.startsWith('-') || /^\s/.test(l) ? l : '- ' + l)).join('\n');
    let out;
    const at = clean.indexOf(today);
    if (at === -1) {
      out = `${clean}\n\n${today}\n${items}`;
    } else {
      // 2026-09-15 修复：同一天多次 tidy 会生成多个同名 ## 日期 段 →
      // 已存在今天的段就把新条目插到该段末尾（下一个 ## 之前）
      const rest = clean.slice(at + today.length);
      const nb = rest.search(/\n##\s/);
      const cut = nb === -1 ? clean.length : at + today.length + nb;
      out = `${clean.slice(0, cut).replace(/\s+$/, '')}\n${items}${clean.slice(cut)}`;
    }
    writeText(af, out.replace(/\s+$/, '') + '\n');
    reindexPage(dir, 'todos-archive.md');
  }
  return {
    moved: moved.length,
    // 条目数（首行）与总行数（含缩进续行）分开报，避免 CLI 上写道"归档 3 条"其实是 1 条 3 行
    items: moved.filter((l) => /^[-*]\s*\[[xX]\]/.test(l)).length,
    open: keep.filter((l) => /^[-*]\s+\[ \]/.test(l.trim())).length,
    before: before.length,
    after: body.length,
    archive: moved.length ? path.join(dir, 'pages', 'todos-archive.md') : null,
  };
}

/**
 * 条目清单 + 退场（2026-09-15，用户要求「低价值/已完成的可以删，但改写前要备份」）
 *
 * **为什么是「移」不是「删」**：用户既定过「软遗忘只降权、物理文件永不删」（历史必须可审计），
 * 又说「大概率不会再问的可以删」。**移到 `pages/archive.md` 同时满足两者** ——
 * 该页在 `ARCHIVED_PAGES` 里，**不进检索池、不进注入**（对使用者而言就是删了），
 * 但内容还在、随时 `page archive.md` 可查、可人工搬回。
 * 另加**两层保险**：① 归档页本身留档 ② 原页改前快照写进 `pages/_bak/<页>.bak-<时间戳>`。
 *
 * ⚠️ 默认 **dry-run**：不带 `apply` 只回报"将移动哪些"，绝不落笔。
 */

/** 把一页切成「条目块」（表格行 / `- ` 条目 + 它的缩进续行），跳过表头与 `|---|` 分隔行 */






export function listItems(dir, { page } = {}) {
  const pagesDir = path.join(dir, 'pages');
  const files = page
    ? [page]
    : fs.readdirSync(pagesDir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && !ARCHIVED_PAGES.has(f));
  const out = [];
  for (const f of files) {
    const text = readText(path.join(pagesDir, f));
    if (!text) continue;
    const lines = text.split('\n');
    for (const b of pageBlocks(lines)) {
      const raw = lines.slice(b.s, b.e + 1).join('\n');
      const { meta } = parseMeta(raw);
      const titleLine = raw.split('\n')[0].replace(/^\s*\|?\s*/, '').replace(/\s*\|.*$/, '');
      out.push({
        page: f,
        line: b.s + 1,
        title: clip(titleLine.replace(/[*`]/g, ''), 46),
        i: meta.importance || null,
        date: (raw.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/) || [])[0] || null,
        len: raw.length,
        raw,
      });
    }
  }
  return out;
}

/** 把匹配到的条目**移**到 `pages/archive.md`（dry-run 默认；`apply` 才落笔并备份） */






export function archiveItems(dir, { page, pattern, apply = false } = {}) {
  // ⚠️ 所有分支都带上 `moved`（哪怕是空数组）：出错分支若缺字段，调用方一句 `.moved.length` 就炸
  // —— 这里刚踩过（测试里没传 --match，直接 TypeError），"返回结构要稳定"比"少写几个字"重要。
  if (!page) return { moved: [], error: '需要指定 --page <文件名>' };
  if (!pattern) return { moved: [], error: '需要指定 --match <正则>（避免手滑误删）' };
  const src = path.join(dir, 'pages', page);
  const text = readText(src);
  if (!text) return { moved: [], error: `找不到 pages/${page}` };
  const lines = text.split('\n');
  let re;
  try { re = new RegExp(pattern, 'i'); } catch (e) { return { moved: [], error: `正则有问题：${e.message}` }; }
  const blocks = pageBlocks(lines).filter((b) => re.test(lines.slice(b.s, b.e + 1).join('\n')));
  const moved = blocks.map((b) => lines.slice(b.s, b.e + 1).join('\n'));
  if (!moved.length) return { page, moved: [], apply: false, note: '没有条目匹配' };
  if (!apply) return { page, moved, apply: false };

  // ① 原页改前快照
  const bakDir = path.join(dir, 'pages', '_bak');
  fs.mkdirSync(bakDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = path.join(bakDir, `${page}.bak-${stamp}`);
  writeText(bak, text);

  // ② 从原页移除
  const drop = new Set();
  for (const b of blocks) for (let i = b.s; i <= b.e; i++) drop.add(i);
  writeText(src, lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n'));

  // ③ 追加到归档页（该页在 ARCHIVED_PAGES 里 → 不进检索池、不进注入）
  const af = path.join(dir, 'pages', 'archive.md');
  const head = readText(af)
    || '# archive（已退场条目）\n\n'
      + '> 由 `cli.mjs prune --apply` 移入。**不进检索池、不进注入**（见 `ARCHIVED_PAGES`），\n'
      + '> 但内容保留、`page archive.md` 随时可查。**搬回方法**：把行剪回原页 → 删掉本页对应行 → `reindexPage`。\n';
  writeText(af, `${head.replace(/\s+$/, '')}\n\n## 来自 ${page}（${zh()}）\n${moved.join('\n')}\n`);

  reindexPage(dir, page);
  return { page, moved, apply: true, backup: bak, archive: af };
}

/**
 * 定期体检与清理（2026-09-15，用户要求「加上自动清理」）
 *
 * **为什么需要它**：注入瘦身只治标 —— 内容只增不减，配额迟早被追平。
 * 它回答三个问题：① 注入现在用了多少、余量还有多少 ② 哪些条目该退役 ③ 有没有东西烂在队列里。
 *
 * **安全原则**（沿用用户定的那套）：
 *   - **零风险项才自动执行**（`[x]` 已完成待办的归档，本来就由 `tidyRepo` 覆盖）
 *   - **有取舍的只报告**，拍板了才 `prune --apply` 移档（移档自带 `_bak/` 快照）
 *   - **永不物理删除**
 *
 * 退役候选的判据只用**可靠信号**：`i ≤ 2`（人工打分时已经判断过"用户不会再问"）。
 * 不拿"多久没被召回"当判据 —— hook 跑在受限沙箱里，`access.json` 根本写不进去，
 * 那个信号当前等于没有（见 2026-09-15 的 EPERM 事故）。
 */






export function sweepRepo(dir, { apply = false, budget = INJECT_BUDGET } = {}) {
  const pagesDir = path.join(dir, 'pages');
  const files = fs.existsSync(pagesDir)
    ? fs.readdirSync(pagesDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    : [];
  // 体检前先重建索引（2026-09-17）：sweep 判的是**当前状态**，而 index.json 可能已经旧了 ——
  // 实测删掉一条重复条目后 sweep 仍报「重复 1 对」，就是因为它读的是旧索引。
  // 体检要看得准，就得先自己对齐（索引是派生物，重建无副作用）。
  for (const f of files) {
    if (ARCHIVED_PAGES.has(f)) continue;
    try { reindexPage(dir, f); } catch { /* 单页失败不影响整体体检 */ }
  }
  const pages = [];
  const lowValue = [];
  for (const f of files) {
    const text = readText(path.join(pagesDir, f));
    const lines = text.split('\n');
    const blocks = pageBlocks(lines);
    let low = 0;
    for (const b of blocks) {
      const raw = lines.slice(b.s, b.e + 1).join('\n');
      const { meta } = parseMeta(raw);
      // ⚠️ 归档页里的低分条目**不算"退役候选"** —— 它们**已经退役了**（prune 移档过去的）。
      //    2026-09-17 实测：不排除的话，sweep 会把 archive.md 里那 6 条反复报成"待拍板"，
      //    看起来像还有一批要处理，实际是体检工具在重复报警。
      if (meta.importance && meta.importance <= 2 && !ARCHIVED_PAGES.has(f)) {
        low++;
        lowValue.push({
          page: f,
          line: b.s + 1,
          i: meta.importance,
          title: clip(raw.split('\n')[0].replace(/^\s*\|?\s*/, '').replace(/\s*\|.*$/, '').replace(/[*`]/g, ''), 46),
        });
      }
    }
    pages.push({ page: f, chars: text.length, items: blocks.length, low, archived: ARCHIVED_PAGES.has(f) });
  }

  // inbox 是「待整理队列」：里面有东西就说明有人（我）没出队 —— 2026-09-15 已经栽过一次
  // （两条早已消化的任务书沉积在里面，冒充知识参与了召回）
  // —— 重复检测（2026-09-17 新增）：重复**同时是「内容虚增」和「精度下降」** ——
  //    它白占注入预算，还把同一主题的分数摊薄到两条上（实测 faults.md 里
  //    「DSH 页面卡顿 / 渲染进程 CPU 高」就存在两条，一字不差）。
  //    判据用 tokenize + Jaccard ≥ 0.8（高度相似才算），这也呼应「提高检索精度」：
  //    与其调排序参数，不如先去掉"同一个答案的两份拷贝"。
  const dupes = (() => {
    const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
    const docs = (idx.docs || []).filter((d) => d.kind === 'page' && !ARCHIVED_PAGES.has(d.page) && !META_PAGES.has(d.page) && !isNoIndexPage(d.page));
    // 2026-10-23 **精确剪枝**：实测这项 O(n²) 在 1102 条文档上要 **8.75 秒**（sweep 全程 14.7 秒的大头）。
    // 依据是个**恒等式**，不是拍脑袋的阈值：J = |A∩B| / |A∪B| ≤ min/max
    //   ⇒ 只要 min < 0.8·max（即两边 token 数差太多），J 必然 < 0.8 ⇒ 这一对**可以整对跳过、零漏检**。
    // 做法：按 token 数升序排，内层一旦「比当前大出 1.25 倍」就 break（排过序 ⇒ 后面只会更大）。
    const sets = docs.map((d) => new Set(d.tokens || []));
    const pick = [];
    for (let i = 0; i < docs.length; i += 1) if (sets[i].size >= 8) pick.push(i);   // 过短的条目不做相似判定
    pick.sort((a, b) => sets[a].size - sets[b].size);
    const out = [];
    for (let x = 0; x < pick.length; x += 1) {
      const i = pick[x];
      const A = sets[i];
      for (let y = x + 1; y < pick.length; y += 1) {
        const j = pick[y];
        const B = sets[j];
        if (A.size < B.size * 0.8) break;            // 精确剪枝：这一对及后面所有更大的对都不可能达标
        let inter = 0;
        for (const tk of A) if (B.has(tk)) inter++;
        const jac = inter / (A.size + B.size - inter);
        if (jac >= 0.8) out.push({
          a: docs[i].id, b: docs[j].id, sim: Number(jac.toFixed(3)),
          titleA: clip(docs[i].title || '', 40), titleB: clip(docs[j].title || '', 40),
        });
      }
    }
    return out.sort((x, y) => y.sim - x.sim).slice(0, 20);
  })();

  const inboxItems = pageBlocks(readText(path.join(pagesDir, 'inbox.md')).split('\n')).length;

  // 零风险自动项：已完成待办归档（复用 tidyRepo，它自己也会去重、压空行）
  let tidy = null;
  if (apply) { try { tidy = tidyRepo(dir); } catch { tidy = null; } }

  const boot = bootstrapText(dir, { budget });
  return {
    budget,
    injectChars: boot.length,
    headroom: budget - boot.length,
    pages: pages.sort((a, b) => b.chars - a.chars),
    lowValue,
    dupes,
    // 余量告警（2026-09-17）：注入余量低于 800 就该动手瘦身了 —— 否则下一个
    // 新增的段/条目会静默顶掉排在最后的内容（那是正在发生的、看不见的损失）。
    headroomWarn: (budget - boot.length) < 800,
    inbox: { items: inboxItems, needsWork: inboxItems > 0 },
    tidy,
  };
}
