// day —— 「按天索引」页生成器（2026-10-18 用户提）
// ============================================================
// **为什么要有它**：知识页按**主题**分（events/decisions/lessons/faults…），**时间维度没有一级入口** ——
//   想问「上周三干了啥」只能翻 `journal/`（那是会话流水、不是知识），或者靠 recall 碰运气。
// **做法**：每天一页 `pages/days/YYYY-MM-DD.md`，标题 =「日期 · 当天极致精简的总结」，
//   正文 = 从各页自动抽出的**当天条目**（带来源标注）。用户原话：「大文件变小文件而已」。
// ⚠️ 只**生成/覆盖这一天**，不动任何知识页；摘要是自动截的，可以手改。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { readText, writeText } from '../core.mjs';
import { indexDocs, reindexPage } from '../index.mjs';

/** 抽取来源：页名 → 中文节名（顺序即页面里的节顺序）。 */
const SRC = [
  ['events.md', '事件'],
  ['decisions.md', '决策'],
  ['lessons.md', '教训'],
  ['faults.md', '故障'],
];

/** 去掉 markdown 记号，让摘要/条目干净。 */
/** 去掉 markdown 记号 + **开头重复的日期**（历史条目里有「2026-10-18 2026-10-18 …」这种双日期）。 */
export const stripMd = (s) => {
  let t = String(s).replace(/\*\*/g, '').replace(/`/g, '').trim();
  // 反复剥「- 」与「日期」前缀（历史条目有「- 2026-10-18 - 2026-10-18 …」这种）
  for (let i = 0; i < 4; i += 1) {
    const before = t;
    t = t.replace(/^[-*]\s+/, '').replace(/^\d{4}-\d{2}-\d{2}\s+/, '').trim();
    if (t === before) break;
  }
  return t;
};

/** 收集某天的条目（`- YYYY-MM-DD …` 开头的行）。 */
export function buildDay(dir, date) {
  const sections = [];
  for (const [page, label] of SRC) {
    const text = readText(path.join(dir, 'pages', page));
    const items = [];
    for (const line of text.split('\n')) {
      const m = /^\s*-\s+(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(line);
      if (m && m[1] === date && m[2].trim()) items.push(m[2].trim());
    }
    if (items.length) sections.push({ page, label, items });
  }
  return sections;
}

function renderDay(date, sections) {
  const first = sections.length ? stripMd(sections[0].items[0]).slice(0, 34) : '（当天无记录）';
  const L = [];
  L.push(`# ${date} · ${first}`);
  L.push('');
  L.push(`> 自动生成（\`node bank/cli.mjs day ${date}\`），来源：当天 events / decisions / lessons / faults 的条目。`);
  L.push('> **这是「按天」索引入口** —— 找「那天发生了什么」从这里进；`journal/` 是会话流水、不是知识。');
  L.push('> 标题里那句是自动截的第一条；想改就手改这一行。');
  L.push('');
  for (const s of sections) {
    L.push(`## ${s.label}（${s.page} · ${s.items.length} 条）`);
    for (const it of s.items) L.push(`- ${stripMd(it).slice(0, 220)}`);
    L.push('');
  }
  if (!sections.length) L.push('（当天没有在知识页留下条目）', '');
  return L.join('\n');
}

/** 生成并落盘一天；返回 { file, total }。 */
export function writeDay(dir, date, log) {
  const sections = buildDay(dir, date);
  const d = path.join(dir, 'pages', 'days');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, `${date}.md`);
  writeText(f, renderDay(date, sections));
  try { reindexPage(dir, `days/${date}.md`); } catch { /* 索引失败不拖垮生成 */ }
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  if (log) log(`days/${date}.md（${total} 条，来自 ${sections.length} 个页）`);
  return { file: f, total };
}
