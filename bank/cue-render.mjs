// ============================================================================
// Memory Bank · cue-render —— cue 的「打分 + 渲染」（2026-10-26 从 cue.mjs 按域拆出）
//
// 为什么拆：cue.mjs 实测 279 / 预算 240（116%）。本表的规矩是「超限先按域拆分，别压缩行宽」，
// 先例：cue-suggest.mjs（68/80）、hooks/payload.mjs（26/30）。
//
// 切出来的是两块**互不相关的职责**：
//   ① scoreCueHits —— 命中 → 概率（2026-10-26 用户提的「像流式输出那样给词表概率」）
//   ② formatCueNote —— 命中 → 注入段（两级：1 条正文 + N 条路牌）
// 另带两条「正文化妆」（stripSectionHead / pickActionable）：它们管的是**注入好不好读**，
// 跟「谁会触发」无关 —— 留在 cue.mjs 只会让它继续胖。
//
// ⚠️ 依赖方向：cue-render **不 import cue.mjs**（无环）。`LEVEL_RANK` 搬到这边、由 cue.mjs import，
//    免得出现「两份排序权重」这种漂移源（同族教训：MIN_SCORE 曾经各抄一份，见 config-keys 头注释）。
// ============================================================================
import { clip, cutText } from './core.mjs';
import { CUE_BODY_HITS, CUE_BUDGET, CUE_ENTRY_CHARS, CUE_MAX_ROADS } from './config-keys.mjs';

/** 档位优先级：数字越小越优先（同词长下按它排） */
export const LEVEL_RANK = { cue: 0, rel: 1, tag: 2 };

/** 剥掉条目正文开头的页面章节标题（`7. 故障备忘（速查）` / `## xxx` 这类）。
 *  2026-10-26 实测：不剥的话，cue 注入的正文第一行是章节名 —— 既白吃预算（标题 44 + 章节名 12
 *  就吃掉四分之一），又让人读不出"这到底是哪一条"。同时剥掉表格行的首尾竖线。 */
export const stripSectionHead = (s) => String(s || '')
  .replace(/^\s*\d+\.\s*[^\n]{0,40}\n/, '')
  .replace(/^\s*#{1,6}\s*[^\n]{0,60}\n/, '')
  .replace(/^附[：:][^\n]{0,80}\n/, '')        // 上一条的「附：…」续行被切分算进了本条（2026-10-26 实测）
  .replace(/^\s*\|[\s|]*\|?\s*\n?/, '')       // 表格首竖线
  .replace(/\s*\|\s*$/gm, '')                 // 表格尾竖线（逐行）
  .replace(/^\s*[-*]\s+/, '')                 // 列表符号
  .trim();

/** 从条目正文里优先挑「能指导动作」的那段（修法 / 铁律 / 判据 / 处方 / 结论 / 正确做法）。
 *  起因（2026-10-26 实测）：表格型条目最长的是「现象」，而注入只需要「怎么修」——
 *  从头截 180 字经常正好切在「**修法」三个字之前，等于把最该看的掐掉了。 */
export const pickActionable = (s, max = CUE_ENTRY_CHARS) => {
  const t = String(s || '');
  const m = /(\*\*(?:修法|铁律|判据|处方|结论|正确做法|要点|规则)[^*]{0,24}\*\*)/.exec(t);
  if (m && m.index > 24) {
    const lead = t.slice(0, Math.min(m.index, 36));           // 一点点前文，别让人没上下文
    return cutText(lead + '…' + t.slice(m.index), max);
  }
  return cutText(t, max);
};

/**
 * 给命中打分 → 归一化成概率（**确定性**，不是随机采样；注入每轮必须可复现）。
 * 作用不是"抽签"，而是把「谁配拿正文 / 谁只配当路牌」从硬编码的「词长 → 重要度」
 * 升级成**权重明确的可解释分配**：
 *
 *   score = √词长 × idf × 重要度系数 × 重复系数
 *
 *   · 词长：越长越具体（`file changed since` 远比 `BOM` 精确）→ 开方压一下，避免长词通吃；
 *   · idf：`log(1 + N/(1+df))` —— 越稀罕的词信息量越大（沿用检索的老判据，不是新造）；
 *   · 重要度：条目自己标的 `i`（3 普通 / 5 红线），±15% 微调，不让它盖过词本身；
 *   · 重复：同一个词在一次提问里出现多次 ⇒ 是重点，每次 ×1.25。
 *
 * ⚠️ 三个因子都带**饱和**（开方 / log / 上限），刻意不让人一口气吃满 —— 概率只用来排序和
 *   分配预算，不参与「这条对不对」的判断（同 mood 的权限表：加权只准进 rank）。
 */
export function scoreCueHits(table, hits = [], text = '') {
  const t = String(text || '').toLowerCase();
  const N = Math.max(1, table?.docCount || 1);
  const scored = hits.map((h) => {
    const dfv = Number(table?.dfs?.[h.word] ?? 1);
    const idf = Math.log(1 + N / (1 + Math.max(0, dfv)));
    const lenBoost = Math.sqrt(Math.max(2, h.len || 2)) / Math.SQRT2;
    const iBoost = 1 + 0.15 * (((h.entry?.i ?? 3) - 3));
    const occurrences = String(h.word || '').length ? t.split(String(h.word).toLowerCase()).length - 1 : 1;
    const repBoost = 1 + 0.25 * Math.max(0, occurrences - 1);
    return { ...h, score: Math.max(0.001, lenBoost * idf * Math.max(0.4, iBoost) * repBoost) };
  }).sort((a, b) => (b.score - a.score)
    || (LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
    || (b.len - a.len)
    || ((b.entry?.i || 3) - (a.entry?.i || 3)));
  const total = scored.reduce((s, h) => s + h.score, 0) || 1;
  return scored.map((h) => ({ ...h, p: h.score / total }));
}

/** 渲染成注入段。返回空串＝不注入（保持安静，别每轮灌废话）。 */
export function formatCueNote(hits = []) {
  const rows = hits.filter((h) => h?.entry);
  if (!rows.length) return '';
  // 词去重（两条记忆可能由同一个词带出，别写成「看到「乱码」、看到「乱码」」）；
  // 标题剥掉 markdown 加粗、压到 44 字 —— 它现在只是"路牌"，全文靠 `page <文件>` 去看。
  const words = [...new Set(rows.map((h) => h.word))];
  // head 也要限量：词多的时候「看到「A」、看到「B」…」能把半条预算吃光（实测 5 个词 ≈ 100 字）
  const head = `（联想触发 · ${words.slice(0, 3).map((w) => `看到「${w}」`).join('、')}${
    words.length > 3 ? ` 等 ${words.length} 个词` : ''}）`;
  // 两级渲染（2026-10-26，起因见 config-keys 的 CUE_MAX_HITS 注释）：
  //   ① 只有 **p 最高的一条**给正文 —— 这一条必须是完整的、能直接指导动作的；
  //   ② 其余降级成「page｜标题」路牌（每条 ~28 字），**要不要拉详情由我判断**
  //      ⇒ 名额不再由 hook 替我砍，而是我读了路牌再决定 `cli page`。
  const bodyRows = rows.slice(0, CUE_BODY_HITS);
  const roadRows = rows.slice(CUE_BODY_HITS, CUE_BODY_HITS + CUE_MAX_ROADS);
  const roadLine = roadRows.length
    ? `\n另 ${roadRows.length} 条（要细节自己 \`page <文件>\`）${
      roadRows.map((h) => `\n· ${h.entry.page}｜${clip(String(h.entry.title || '').replace(/\*\*/g, '').trim(), 30)}`).join('')}`
    : '';
  // 预算硬上限（2026-10-26）：`cutText` 按行边界截、不保证不超，实测「head 70 + 正文 140 + 路牌 130」
  // 拼出来 407 > 320。⇒ 先给路牌留足，再对 head+正文**硬切**到剩余额度，保证总长 ≤ CUE_BUDGET。
  const avail = Math.max(60, CUE_BUDGET - roadLine.length);
  const headLine = head + '\n';
  const rawBody = bodyRows.map((h) => {
    const t = clip(String(h.entry.title || '').replace(/\*\*/g, '').trim(), 44);
    return `【${h.entry.page}｜${t}】\n${h.entry.text}`;
  }).join('\n');
  const body = cutText(rawBody, Math.max(100, avail - headLine.length));
  return (headLine + body).slice(0, avail) + roadLine;
}
