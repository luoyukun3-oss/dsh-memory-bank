// ============================================================================
// Memory Bank · cue —— 「触发式联想」（2026-10-13 新增）
//
// 与 assoc.mjs 的分工（**这是两件事，别混**）：
//   assoc：**条目 → 条目**。已经命中了 A，顺带想起同标签/人工边/共现的 B。
//         它的前提是「先得有一次主命中」——三种联想分数都低于 hook 的注入门槛，
//         自己永远不触发注入（设计如此，见 assoc.mjs 头注释）。
//   cue  ：**词 → 条目**。听到/看到某个词，**不管有没有主命中**，直接想起某条记忆。
//         这才是用户 2026-10-12 说的「触发式」：「你经常被编码格式不对看到一堆乱码，
//         那你看到乱码或者看到编码格式就想到」——条件反射，不依赖别的回忆先被想起来。
//
// 词从哪来（三档来源，可靠度由高到低 —— 判据：谁能保证"人工确认过"）：
//   cue  显式标注 `<!-- cue:乱码,编码 -->`：写条目时就说过「看到这个词就想起我」。**最可靠**。
//   rel  人工边 `rel:页:关键词` 的**关键词**：本来就是这个用途（人工判断过的特征词）。
//   tag  `t:` 主题标签：粗（零成本可批量打），**必须过 df 门** —— 见下。
//
// ⚠️ 为什么 tag 要过 df 门（2026-10-13 拿真库标定，不是拍的）：
//   实测 815 条上「插件」出现过 14.4% 的条目、「DSH」29.9%、「验证」16.7%、「会话」22.8%
//   —— 这类词在**任何**工具输出里都会出现，当触发词等于每轮都触发、把注入预算烧光。
//   而用户举的例子恰好都在安全区：乱码 2.6% / 编码 3.1% / GBK 1.2% / BOM 2.8% / UTF-8 3.9%。
//   ⇒ 阈值取 **8%**（`CUE_DF_MAX`）：挡住上面那批泛词，保住「卡顿 2.0% / 断流 0.7% /
//     写盘停摆 0.1%」这些真正有指向性的词。标定数据与全表见 `_cue_probe_out.txt` 那轮探查
//     （临时脚本已删，分布结论记在本地 budgets-history.md 的 _rebudget_note_20261013）。
//
// ⚠️ 分模式（prompt / output）——**为什么要分**：
//   提问是用户精心打的几十个字；工具输出动辄几 KB，**同一批词的误触发概率差两个数量级**。
//   所以 output 模式（PostToolUse）**只认 cue 级**（人工显式标注过的），prompt 模式才放开三档。
//   ⇒ 代价：库里没有 `cue:` 标注时 output 模式是哑的（这是**有意**的空转，不是坏了）。
//
// ⚠️ 缓存：hook 每轮要跑，不能每次解析 4 MB 的 index.json（实测约 60~100 ms）。
//   故把「词 → 条目摘要」预生成成小文件 `cue.json`，带 `srcMtime` 过期判据。
//   在只读沙箱的 hook 里写盘会 EPERM ⇒ **静默降级为内存重建**（正确但慢），
//   由有写权限的进程（cli / ingest）顺手把它落盘，下次 hook 就快了。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVED_PAGES, META_PAGES, clip, cutText, readJson, writeJson } from './core.mjs';
import { CUE_DF_MAX, CUE_DF_MAX_OUTPUT, CUE_MAX_HITS, CUE_MAX_LEN, CUE_MAX_LEN_CUE, CUE_MIN_LEN } from './config-keys.mjs';
// 2026-10-26：**打分与渲染搬去 cue-render.mjs**（本文件实测 279 / 预算 240，按域拆而不是压注释）。
// LEVEL_RANK 也从那边来 —— 免得两份排序权重各写一遍（同族漂移教训见 config-keys 头注释）。
import { LEVEL_RANK, formatCueNote, pickActionable, scoreCueHits, stripSectionHead } from './cue-render.mjs';

const CACHE_FILE = 'cue.json';
/** 档位优先级见 cue-render.mjs 的 LEVEL_RANK（2026-10-26 按域拆） */

/**
 * 停用词表 —— **判据不是"泛"，而是「在与这条教训无关的语境里也会出现」**。
 * 三个词都是 2026-10-13 拿 129 条真实提问回放**实测**出来的假阳性（不是想出来的）：
 *   `self` —— 英文单词 your**self** / it**self** 里都含它（"generate an SVG of a yourself" 这种也命中）；
 *   `open` —— Python 内置函数名，任何文件操作报错的 traceback 里都有它；
 *   `内存` —— 用户问"32g 内存的笔记本"也会命中「游戏崩 Ran out of memory」那条。
 * 它们各自的 df 都不高（2~5%），**df 门挡不住** —— 这正是"两个判据互不替代"的例子：
 * df 管"库里常见"，停用词表管"语境里常见"。新增词前先回放一遍（脚本见 budgets.json 的 20261013 条）。
 */
const CUE_STOP = new Set(['self', 'open', '内存']);

/** 一个词配不配当触发词：太短（单字）会漫天误触发，太长没人会那么说。
 *  `allowSpace`（只给 `cue:` 档）：它可以是**一整段报错原文** —— 那才是最好的触发词
 *  （「看到 `has not been read` 就想起那条」比"看到 write 就想起"精确得多）。
 *  ⚠️ 含空格时仍必须挡住 `:` `<` `>` 与连续 `--`：它们会把行尾 HTML 注释的语法撑破。 */
export function cueWordOk(w, { allowSpace = false, maxLen = CUE_MAX_LEN } = {}) {
  const s = String(w || '').trim();
  if (s.length < CUE_MIN_LEN || s.length > maxLen) return false;
  if (CUE_STOP.has(s.toLowerCase())) return false;
  const bad = allowSpace ? /[:<>]|--|\n/ : /[\s,，、;；:：!！?？"'`()（）[\]【】<>《》·|/\\]/;
  return !bad.test(s) && !/^\d+$/.test(s);   // 纯数字（版本号/端口）不当触发词
}

/**
 * 由 docs 建「词 → 条目」表（**纯函数**，便于单测；不读盘、不写盘）。
 * df 用**索引里的 tokens**（中文是 bigram，2 字词正好一个 token）⇒ O(词数 × 条数) 次 Set 查找，
 * 毫秒级；>2 字的英文/长词才退化成子串扫描（这类词数量少）。
 */
export function buildCueTable(docs) {
  // ⚠️ 2026-10-23 开了一个口子：**`memo.md` 允许进 cue 表**（其它 META_PAGES 照旧排除）。
  //    起因是用户的原话——「某些事也可以绑定，再次看到这个东西就能马上想起来，
  //    比如哲学就想到我和你聊的 AI 心理和灵魂问题」。而 memo 就是那种**记忆锚点**：
  //    它不进召回（META_PAGES 语义不变）、不参与正文检索，但**它的 cue 词要能触发**，
  //    否则「说到哲学就想起那晚的对话」这条永远做不到 —— 静音是对的，静音到连触发都没有是错的。
  const usable = (docs || []).filter((d) => d && d.page
    && !ARCHIVED_PAGES.has(d.page) && (!META_PAGES.has(d.page) || d.page === 'memo.md')
    && d.page !== 'inbox.md'
    && d.meta?.confidence !== 'low' && !d.meta?.supersededBy);
  const tokenSets = usable.map((d) => new Set(d.tokens || []));
  const texts = usable.map((d) => ((d.title || '') + '\n' + (d.text || '')).toLowerCase());
  const df = (w) => {
    const lw = String(w).toLowerCase();
    return lw.length <= 2
      ? tokenSets.reduce((n, s) => n + (s.has(lw) ? 1 : 0), 0)
      : texts.reduce((n, t) => n + (t.includes(lw) ? 1 : 0), 0);
  };
  const words = new Map();
  const entries = {};
  const add = (w, d, level) => {
    const key = String(w).trim();
    if (!words.has(key)) words.set(key, []);
    words.get(key).push({ id: d.id, level });
    if (!entries[d.id]) {
      entries[d.id] = {
        page: d.page, kind: d.kind, title: d.title || '', i: d.meta?.importance || 3,
        text: pickActionable(stripSectionHead(d.text || '')),
      };
    }
  };
  let skipped = 0;
  for (const d of usable) {
    const m = d.meta || {};
    for (const w of (m.cues || [])) {
      // `+` = 空格：注释按空白切分，所以「报错原文」这种带空格的触发词只能这样写（见 config-keys 的 CUE_MAX_LEN_CUE）
      const key = String(w).trim().replace(/\+/g, ' ');
      if (!cueWordOk(key, { allowSpace: true, maxLen: CUE_MAX_LEN_CUE })) { skipped++; continue; }
      // 2026-10-29：cue 档原先以「人工标注过」为由免 df 检（tag 档有门、cue/rel 没有）⇒ 留了 15 个泛词的口子。
      // 最坏的是「实测」：df 23.4% 却只挂 1 条 ⇒ scoreCueHits 归一化后 p=1.00，独占唯一的 CUE_BODY_HITS
      // 正文名额，等于**每轮无条件注入同一条无关记忆**（误报实测见 记忆库体检-2026-10-29.md 第四节）。
      // 人工标注 ≠ 不会写出泛词 ⇒ 与 tag 档同门。df < 8% 的「环境/静默/rev」本门挡不住，靠删标注处理。
      if (df(key) / (usable.length || 1) > CUE_DF_MAX) { skipped++; continue; }
      add(key, d, 'cue');
    }
    // 2026-10-29：rel 标注允许把**加粗符号**写进关键词字段（`rel:lessons.md:**⑧:attribute`），
    // 全库 25 个 rel 词里 7 个以 `**` 开头 ⇒ 全是哑弹（正文里不存在「**⑧」这个串，实测命中 0 条）。
    // 只剥「两个以上星号」的前后缀，`*args` 这类真正的 Python 词不受影响。
    for (const r of (m.rel || [])) {
      const rk = String(r.key || '').replace(/^\*{2,}|\*{2,}$/g, '').trim();
      if (cueWordOk(rk)) add(rk, d, 'rel');
    }
    for (const t of (m.tags || [])) {
      if (!cueWordOk(t)) continue;
      if (df(t) / (usable.length || 1) > CUE_DF_MAX) { skipped++; continue; }   // 泛词不进触发词表
      add(t, d, 'tag');
    }
  }
  const out = {};
  const weak = {};   // 「在工具输出里太常见、不够特征」的词（df 门见 config-keys 的 CUE_DF_MAX_OUTPUT）
  const dfs = {};    // 词 → df（打分用的 idf 原料；2026-10-26 新增，不改变 words 的形状）
  for (const [w, list] of words) {
    out[w] = list;
    dfs[w] = df(w);
    if (dfs[w] / (usable.length || 1) > CUE_DF_MAX_OUTPUT) weak[w] = true;
  }
  return { words: out, entries, weak, dfs, docCount: usable.length, skipped };
}

/** 读缓存表；`index.json` 变过就重建。写盘失败（只读沙箱）静默降级。 */
export function loadCueTable(dir, docs, { rebuild = false } = {}) {
  const idxFile = path.join(dir, 'index.json');
  let mt = 0;
  try { mt = fs.statSync(idxFile).mtimeMs; } catch { /* 没索引就当 0 */ }
  const cached = rebuild ? null : readJson(path.join(dir, CACHE_FILE), null);
  if (cached && cached.srcMtime === mt && cached.words) return cached;
  const table = { ...buildCueTable(docs && docs.length ? docs : (readJson(idxFile, { docs: [] }).docs || [])), srcMtime: mt };
  try { writeJson(path.join(dir, CACHE_FILE), table); } catch { /* hook 只读沙箱：静默 */ }
  return table;
}

/**
 * 在文本里找触发词。`mode`：'prompt'（提问，三档全开）/ 'output'（工具输出，只认 cue 档）。
 * 同一个条目被多个词命中时只留**最长**的那个词（长词更具体，说出来更像话）。
 */
export function matchCues(table, text, mode = 'prompt', { limit = CUE_MAX_HITS } = {}) {
  const t = String(text || '').toLowerCase();
  if (!t || !table?.words) return [];
  const allow = mode === 'output' ? ['cue'] : ['cue', 'rel', 'tag'];
  const best = new Map();
  for (const [w, list] of Object.entries(table.words)) {
    // output 模式先过词筛：工具输出是海量文本，`write`/`hook`/`window` 这类高频词会把它淹掉
    // （2026-10-13 回放实测：不加这道门命中率 55%，加了之后见 budgets.json 的同日条）。
    if (mode === 'output' && table.weak?.[w]) continue;
    if (!t.includes(w.toLowerCase())) continue;
    for (const it of list) {
      if (!allow.includes(it.level)) continue;
      const prev = best.get(it.id);
      const cand = { id: it.id, word: w, level: it.level, len: w.length };
      if (!prev || cand.len > prev.len
        || (cand.len === prev.len && LEVEL_RANK[cand.level] < LEVEL_RANK[prev.level])) best.set(it.id, cand);
    }
  }
  const picked = [...best.values()]
    // 先做一次**硬排序**（档位 → 词长 → 重要度），它现在是 scoreCueHits 的 tie-break 底座：
    // ⚠️ 必须有确定性的 tie-break，否则同一个词带出哪条会随对象序漂，看结果时无法判断
    //    「是词表变了还是排序抖了」（同族教训：分数每毫秒都在飘那次）。
    .sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
      || (b.len - a.len)
      || ((table.entries[b.id]?.i || 3) - (table.entries[a.id]?.i || 3)))
    .slice(0, limit)
    .map((h) => ({ ...h, entry: table.entries[h.id] || null }))
    .filter((h) => h.entry);
  // 2026-10-26（用户提议：「像流式输出那样给词表概率」）：返回前统一打分并归一化成 p，
  // 调用方拿到的已是 **p 降序**；formatCueNote 用 p 决定「谁配拿那唯一的正文名额」。
  return scoreCueHits(table, picked, text);
}

// scoreCueHits / formatCueNote 已搬到 cue-render.mjs（2026-10-26 按域拆：本文件 279/240 超限）。
// 这里 re-export，外部调用方（hooks / bootstrap / cli）无需改动。
export { formatCueNote };

/** `cli cue` 的报告（渲染放这里、cli 只做调度 —— 先例：dream / patch-status / dead-audit）。 */
export function formatCueReport(table, hits, mode) {
  const lists = Object.values(table.words || {});
  const by = (lv) => lists.filter((l) => l.some((x) => x.level === lv)).length;
  const head = `词表 ${lists.length} 个（cue ${by('cue')} / rel ${by('rel')} / tag ${by('tag')}）`
    + `｜按 df 门跳过 ${table.skipped || 0} 个泛词｜模式 ${mode}`;
  if (!hits.length) return `${head}\n（没有触发任何联想）`;
  const rows = hits.map((h) => `· 「${h.word}」（${h.level} 档${h.p != null ? `· p=${h.p.toFixed(2)}` : ''}）→ ${h.entry.page}｜${h.entry.title}`).join('\n');
  return `${head}\n命中 ${hits.length} 条：\n${rows}\n\n———— 实际会注入的文本 ————\n${formatCueNote(hits)}`;
}
