// ============================================================================
// Memory Bank · reflect 的「教训候选」域（2026-11-09 从 reflect.mjs 按域拆出）
//   为什么拆：reflect.mjs 实测 215 / 预算 220（98%）逼近红线，按 budgets.json 的
//   「超限先按域拆、别压缩行宽硬塞」处理。本域只回答：「哪些主题最近很活跃、
//   但 `lessons.md` 里还没记过」—— 判据、阈值标定、勾选状态沿用的注释全在下面。
//   ⚠️ 只读（search 读索引、readText 读旧反思），不写任何文件（落盘仍在 reflect.mjs）。
// ============================================================================
import { clip, readText } from './core.mjs';
import { search } from './search.mjs';
import { buildSearchContext } from './search-context.mjs';   // 索引预载：10 次 search 共用一份（2026-11-09）
import path from 'node:path';
import fs from 'node:fs';

/** 教训候选：{ candidates, coveredThemes, doneTokens }
 *  → candidates    = [[主题, 出现次数, 最接近条目(分数)]…]（渲染成 `- [ ] \`主题\`（出现 N 次）— 最接近：…`）
 *  → coveredThemes = ["主题 ← 最接近条目（分数）"…]（"已记过，无需重复固化"那行）
 *  → doneTokens    = 上一次反思里已划 `[x]` 的主题集合（沿用勾选，避免同一批候选天天重复提醒） */
export function lessonCandidates(dir, themes) {
  // 五、教训候选（2026-09-15 重做）：原先 = 「高频话题的子集」，于是跟第一节输出同一堆二元组碎片，
  // 白白占掉一整节。改成**有判据的问题**：某个主题最近反复出现，但 `lessons.md` 里**还没记过它**。
  // 判「记没记过」用**检索**而不是字面 `includes` —— 字面匹配会被同义说法骗（lessons 里写的是
  // "三角形"/"记忆系统"，别名组的词却是"三角形类型判断"/"记忆银行"，字面不中就误报）。
  // 先用 20 条再筛 `lessons.md`：直接坐 `recall(k=3)` 会被 meta/decisions 这类页面挤掉。
  // 阈值 1.2 来自实测分布（2026-09-15）：≥1.8 全是真相关（range 5.57 / 数字输入容错 8.44 /
  // 三角形 3.85），≤0.8 基本是噪声命中（0.72 撞上"hook 命令必须是 PowerShell 语法"这种无关条目）。
  // 判错的代价用**透明度**兜住：不论判哪边，都把「最接近的条目 + 分数」打出来，能看见证据。
  const KNOWN_MIN = 1.2;
  const candidates = [];
  const coveredThemes = [];
  // ★ 10 次 search 共用一份预载索引（2026-11-09，依据实测：每次 search 的固定开销 = 读 5.53 MB
  //   index 57 ms + 重建 df 75 ms = **132 ms，与查询词无关** ⇒ 10 次里 1.3 s 全是重复读盘建表）。
  const sctx = buildSearchContext(dir);
  for (const [label, n] of themes) {
    // n==1 的主题**永远不会进候选**（入选门槛就是 n>=2），原先却排在 search 之后 ⇒ 白搜一次
    // （实测 10 个主题里有 4 个属于这种）。挪到搜索之前 ⇒ 少跑 4 次。
    // ⚠️ 行为变化（有意）：`coveredThemes`（"已记过"那行）不再列出 n==1 的主题。
    if (n < 2) continue;
    const top = search(dir, label, 20, sctx).filter((h) => h.page === 'lessons.md')[0];
    const known = !!top && top.score >= KNOWN_MIN;
    const near = top ? `${clip(String(top.title).replace(/[*`]/g, ''), 26)}（${top.score.toFixed(2)}）` : '无';
    if (known) coveredThemes.push(`${label} ← ${near}`);
    else candidates.push([label, n, near]);
  }

  // 候选的「已处理」勾选状态（2026-09-15）：反思写了没人消费，同一批候选就会一天天重复。
  // 上一次反思里已划 `[x]` 的候选会被沿用，不再重复提醒。
  const doneTokens = new Set();
  try {
    const rdir = path.join(dir, 'reflections');
    const prevFiles = fs.readdirSync(rdir).filter((f) => f.endsWith('.md')).sort();
    if (prevFiles.length) {
      const prev = readText(path.join(rdir, prevFiles[prevFiles.length - 1]));
      const sec5 = prev.split('## ').find((s) => s.startsWith('五、')) || '';
      for (const m of sec5.matchAll(/^\s*-\s*\[[xX]\]\s*`([^`]+)`/gm)) doneTokens.add(m[1]);
    }
  } catch { /* 读不到旧反思不影响本次生成 */ }

  return { candidates, coveredThemes, doneTokens };
}
