// ============================================================================
// Memory Bank · reflect 的「未闭环事项」域（2026-11-09 从 reflect.mjs 按域拆出）
//   为什么拆：reflect.mjs 实测 215 / 预算 220（98%）逼近红线，按 budgets.json 的
//   「超限先按域拆、别压缩行宽硬塞」处理。本域只回答一个问题：
//   「主人还有哪些事没闭环」—— 一个来自权威清单（todos.md 未勾选项），一个来自原话线索。
//   ⚠️ 只读 pages/*.md，不写任何文件（落盘仍在 reflect.mjs）。
// ============================================================================
import { clip, isNoise, readText, tokenize } from './core.mjs';
import path from 'node:path';

/** 未闭环事项：{ todoOpen, openEndClues }
 *  → todoOpen      = `pages/todos.md` 里未勾选的项（权威清单）
 *  → openEndClues  = 用户原话里的线索（可能误报，渲染时会注明"供参考"） */
export function openClues(dir, userTexts) {
  // 四之权威清单（2026-09-15 修复误报）：真待办看 `pages/todos.md` 里未勾选的项
  const todoOpen = [];
  for (const line of readText(path.join(dir, 'pages', 'todos.md')).split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[ \]\s+(.+?)\s*$/);
    if (m) todoOpen.push(clip(m[1], 130));
  }
  // 四之线索：用户原话里的关键词命中。排除 ①元问题（"还有什么要做"这类提问）
  // ②已闭环信号 ③与**某一条**已归档事项高度重合的（逐条比对，避免被整个归档文件的 token 池稀释）
  const DONE_RE = /(已经|已完成|搞定了|解决了|弄好了|可以了|装上了|通过了|删掉了|给了|好了)/;
  const META_Q = /(还有什么|是什么|是干嘛|什么意思|怎么弄|有没有什么)/;
  const archItems = readText(path.join(dir, 'pages', 'todos-archive.md'))
    .split('\n')
    .filter((l) => /^\s*[-*]\s*\[[xX]\]/.test(l))
    .map((l) => new Set(tokenize(l)));
  const openEnds = [];
  for (const l of userTexts) {
    if (!/还没|下次|待办|等几天|回头|以后再/.test(l)) continue;
    if (META_Q.test(l) || DONE_RE.test(l)) continue;
    const tk = [...new Set(tokenize(l))].filter((t) => !isNoise(t));
    if (tk.length) {
      let best = 0;
      for (const s of archItems) {
        const hit = tk.filter((t) => s.has(t)).length;
        if (hit / tk.length > best) best = hit / tk.length;
      }
      if (best >= 0.4) continue;   // 与某条已归档事项高度重合 → 视为已闭环
    }
    openEnds.push(l);
  }
  return { todoOpen, openEndClues: openEnds.slice(-6) };
}
