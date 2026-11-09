// ============================================================================
// Memory Bank · explain-basis —— 逐条「命中来源」（match_basis，2026-11-08）
//
// 目的（笔记第五轮 15.7）：「cli recall 加逐条 match_basis（keyword/vector/graph/alias/
//   cue 组合 + 诚实 unknown）—— 能直接看出哪条路在贡献，不必做 A/B」。
//   ⇒ 本文件只回答一个问题：**这条候选凭什么在列表里**。它不评判好坏、不调权重。
//
// 三条硬规矩（改本文件前先读）：
//   ① **不侵入 search() 热路径**。每条 hit 自带的证据已经够用：`tokens`（命中词可精确
//      重算）+ `via`（联想入口，由 assoc.mjs:116 写死）。所以这里只「读 hit + 重算」，
//      一行都不用改 search.mjs —— 它正好在预算顶格（290/290）。
//   ② **判不出来就写 unknown**。与笔记第 8 条「"没找到"永远不等于"没发生过"」同一把尺子：
//      没证据时不许拿"最像的那个标签"充数。unknown 是诚实的结论，不是失败。
//   ③ **alias / synonym 分家**。search.mjs:41 把它们并进同一个 `ext` 数组，但来源不同
//      （aliases.md 人工核对 / synonyms.json LLM 烘焙），所以这里按各自的组**分别重算**
//      扩展词 —— 归属是算出来的，不是"大概是别名吧"。
//
// ⚠️ **cue 没有资格进 match_basis**：`matchCues` 的调用点只有 `hooks/user-prompt.mjs`、
//   `hooks/post-tool.mjs` 与 `cli cue`（本轮 `grep -rn matchCues` 实测），
//   **search()/recall() 从不调用它** ⇒ cue 对本次排序的贡献恒为 0。把它写成命中来源
//   就是瞎猜。它只在 explain 里作为「旁路」标注出现（见 cueOf），且明写"不参与排序"。
// ============================================================================
import { isNoise, loadAliases, tokenize } from './core.mjs';
import { loadSynonyms } from './synonyms.mjs';
import { loadCueTable, matchCues } from './cue.mjs';

/** assoc.mjs 写进 hit 的 `via` 取值 → 标签。不认识的 via **原样输出**（不往已知档里猜）。 */
const VIA_LABEL = { rel: 'rel', rel2: 'rel2', cooccur: 'cooccur', tag: 'tag' };
/** 联想入口的中文说明（只用于渲染）+ 它的排序位置提醒（联想是**追加在池尾**，见 assoc.mjs:116）。 */
const VIA_DOC = {
  rel: '人审边 1 跳', rel2: '人审边 2 跳', cooccur: '同轮共现 ≥2 次', tag: '同主题标签',
};

/**
 * 造一次查询的归因上下文。
 * 扩展词算法与 `search.mjs:30-41` **同构**：命中即整组扩展，且扩展词要剔掉查询原词
 * （search 那边是 `.filter(t => !qt.includes(t))`）。少这一步就会把「纯 keyword 命中」
 * 误标成 alias —— 那正是本项目最反感的假归因。
 *
 * @param {string} dir 仓库银行目录
 * @param {string} query 查询
 * @param {{cue?:boolean}} opts cue=true 才读旁路 cue 表（`cli recall` 默认不读：旁路不该
 *        在"查记忆"的主命令里顺手触发一次表重建；`cli explain` 是诊断工具，读它）
 */
export function buildBasisCtx(dir, query, { cue = false } = {}) {
  const qTokens = [...new Set(tokenize(query))];
  const qlow = String(query || '').toLowerCase();
  const expand = (groups) => {
    const out = new Set();
    for (const g of groups) {
      if (!g.some((w) => w && qlow.includes(w))) continue;
      for (const w of g) for (const t of tokenize(w)) out.add(t);
    }
    for (const t of qTokens) out.delete(t);
    return out;
  };
  const ctx = { qTokens, alias: expand(loadAliases(dir)), synonym: expand(loadSynonyms(dir)), cueById: null };
  if (cue) {
    // 旁路表坏了**不该让诊断工具崩** —— 它只是附加信息，不是主线（同 bumpAccess 的处置态度）。
    try { ctx.cueById = new Map(matchCues(loadCueTable(dir, null), query, 'prompt', { limit: 99 }).map((h) => [h.id, h])); }
    catch { ctx.cueById = null; }
  }
  return ctx;
}

/**
 * 一条 hit 的命中来源。每个字都有据可查：
 *   keyword / alias / synonym —— 由 `hit.tokens` ∩ 查询词 / 别名扩展词 / 同义扩展词**重算**；
 *   rel / rel2 / cooccur / tag —— 读 `hit.via`（联想只有这一条进门的路，assoc.mjs 必写）；
 *   unknown —— 以上都没命中：**说明我们不知道**，不拿最像的东西凑数。
 */
export function basisOf(hit, ctx) {
  const hTok = new Set(hit?.tokens || []);
  const via = hit?.via ? (VIA_LABEL[hit.via] || String(hit.via)) : null;
  const kw = ctx.qTokens.filter((t) => hTok.has(t));
  // ⚠️ **联想条目不许标 alias/synonym**（本轮实测踩到，别再退回去）：assoc 的分数 =
  //    边权 + REL_W × 相关度，而 `makeRelScorer` 只用 `tokenize(query)` 且过 `isNoise`
  //    （assoc-rel.mjs:25-29）⇒ 扩展词对联想条目**一分都没加**。给 via 条目标 alias
  //    就是拿"它对别人有用"冒充"它对这条有用"——正是行 ③ 那条假归因。
  const alias = via ? [] : [...ctx.alias].filter((t) => hTok.has(t));
  const synonym = via ? [] : [...ctx.synonym].filter((t) => hTok.has(t));
  const keyword = via ? kw.filter((t) => !isNoise(t)) : kw;
  const bases = [];
  if (via) bases.push(via);                            // 先写「怎么进来的」，再写「还命中了什么」
  if (keyword.length) bases.push('keyword');
  if (alias.length) bases.push('alias');
  if (synonym.length) bases.push('synonym');
  if (!bases.length) bases.push('unknown');
  const c = ctx?.cueById?.get(hit?.id) || null;
  return { entry: via || 'search', bases, words: { keyword, alias, synonym }, cue: c ? { word: c.word, level: c.level } : null };
}

/** 来源的一句话描述（表格单元 / 脚注共用；证据词单独给，便于渲染时省略） */
export function describe(hit, ctx) {
  const b = basisOf(hit, ctx);
  return { text: b.bases.join('+'), words: b.words, cue: b.cue, entry: b.entry };
}

/**
 * `cli recall` 末尾的逐条来源脚注。
 * ⚠️ 不改 `res.text` —— 那是 recall-assemble 的装配结果（会按预算丢末尾条目），
 *    往里插字符等于改召回观感；脚注按**命中顺序**另起一段，顺序与渲染顺序一致。
 * ⚠️ 「命中」≠「看到了」：装配时预算不够会整条丢掉（recall-assemble.mjs:59 的 MIN_ITEM
 *    分支）。传 `rendered` 就逐条核对有没有真进正文 —— 不核对就是把"命中 5 条"说成
 *    "你看到 5 条"，那是最容易骗过自己的一种错（本轮实测：摸鱼模式那问命中 5 条、正文 3 条）。
 */
export function formatBasisFooter(hits, ctx, { rendered = '' } = {}) {
  if (!hits?.length) return [];
  const shownOf = (h) => !rendered || String(rendered).includes(`【${h.kind}｜${h.title}】`);
  const rows = hits.map((h, i) => {
    const d = describe(h, ctx);
    const ev = [...d.words.alias.map((t) => `alias:${t}`), ...d.words.synonym.map((t) => `syn:${t}`)];
    const cue = d.cue ? ` ｜cue旁路:「${d.cue.word}」(${d.cue.level})` : '';
    const hidden = shownOf(h) ? '' : ' ｜⚠️未进正文（预算丢掉）';
    return `#${i + 1} ${h.page}｜${d.text}${ev.length ? `（${ev.join(' ')}）` : ''}${cue}${hidden}`;
  });
  const hiddenN = hits.filter((h) => !shownOf(h)).length;
  return [`— 逐条来源 match_basis（命中 ${hits.length} 条，按分数序${hiddenN ? `；⚠️ ${hiddenN} 条没进正文` : ''}）—`, ...rows];
}

/**
 * `cli explain` 表格下方的证据段：① 别名/同义扩展词具体贡献了哪几个词；
 * ② 联想入口统计（这些条目**排在池尾**，`--k` 小的时候看不到它们，但不代表没有）。
 */
export function formatBasisEvidence(rows) {
  const out = [];
  const ext = rows.filter((r) => r.basis && (r.basis.words.alias.length || r.basis.words.synonym.length));
  if (ext.length) {
    out.push('');
    out.push('扩展词贡献（search 里 alias/synonym 只加分、不进覆盖率分母）：');
    for (const r of ext.slice(0, 8)) {
      const parts = [];
      if (r.basis.words.alias.length) parts.push(`alias:${r.basis.words.alias.join(' ')}`);
      if (r.basis.words.synonym.length) parts.push(`synonym:${r.basis.words.synonym.join(' ')}`);
      out.push(`  #${r.rank} ${r.page} ← ${parts.join(' ｜ ')}`);
    }
  }
  const assoc = rows.filter((r) => r.basis && r.basis.entry !== 'search');
  if (assoc.length) {
    const by = {};
    for (const r of assoc) by[r.basis.entry] = (by[r.basis.entry] || 0) + 1;
    out.push('');
    out.push(`联想入口（assoc.mjs 追加在池尾 ⇒ 常落在 #41 之后）：${Object.entries(by).map(([k, v]) => `${k} ${v}（${VIA_DOC[k] || '来源未登记'}）`).join('、')}`);
  }
  return out;
}
