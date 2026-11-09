// ============================================================================
// Memory Bank · dream-report —— 「做梦」结果的**渲染出口**（2026-11-09 从 dream.mjs 按域拆出）
//
// 为什么拆：`dream.mjs` 已到 **216/220 行（98%）**，逼近 `budgets.json` 的架构红线；
//   而「候选怎么算」（findDreamPairs：词频/重叠度/枢纽/同日分层）与「结果怎么打印」
//   （formatDreamReport：拼 `cli dream` 与 tick 的行）本来就是**两个域** —— 前者要读盘算分，
//   后者**只读返回值拼字符串**、不读盘、不写盘、不做任何判断。
//
// ⚠️ 对外零变化：`dream.mjs` 用 `export { formatDreamReport } from './dream-report.mjs'` 转发，
//   老路径 `import { formatDreamReport } from './dream.mjs'`（cli.mjs / commands/tick.mjs）照旧可用。
// ⚠️ 本文件**不许 import dream.mjs**（会形成 dream → report → dream 的环）。
// ============================================================================

/**
 * 把结果格式化成 `cli.mjs dream` / `tick` 要打印的行。
 * @param {object} r findDreamPairs() 的返回值
 * @returns {string[]} 每行一条
 */
export function formatDreamReport(r) {
  const evs = r.eventCandidates || [];
  if (!r.all && !evs.length) return [`⑦ 做梦：✅ 本次没有新的「意外关联」（库 ${r.total} 条｜罕见词 ${r.rareWords} 个｜已否决 ${r.discarded} 对${r.eventTotal ? `｜事件 ${r.eventTotal} 条` : ''}${r.eventErr ? `｜事件库跳过（${r.eventErr}）` : ''}）`];
  const hubNote = r.hubs?.length
    ? `｜已自动排除 ${r.hubs.length} 个枢纽页（${r.hubs.slice(0, 3).map((h) => `${h.id}×${h.degree}`).join('、')}）`
    : '';
  const nearNote = r.near ? `｜另有 ${r.near} 组同日/相邻两天的（多半是同一件事的多页落点，\`--near\` 另看）` : '';
  const out = [`⑦ 做梦 —— 找到 ${r.all} 组「无共享标签、却共享罕见词」的条目对（只报告，不动库）${hubNote}${nearNote}：`];
  for (const c of r.candidates) {
    out.push(`   - 重叠 ${(c.overlap * 100).toFixed(0)}%｜共享 ${c.shared} 词：${c.words.slice(0, 8).join('、')}`);
    out.push(`       ${c.a}「${String(c.titleA).slice(0, 34)}」`);
    out.push(`       ${c.b}「${String(c.titleB).slice(0, 34)}」`);
  }
  // —— 事件 × 事件（2026-10-27）：与条目对分开渲染，因为**落地动作不同**（事件建的是库里的边，
  //    条目建的是 md 里的 `rel:`）；同日的事件已在 dream-events 里滤掉，这里不重复说明。
  if (evs.length) {
    out.push(`   ┄ 事件 × 事件：${evs.length} 组「共享稀有实体」（库里 ${r.eventTotal} 条事件 / ${r.eventRare} 个稀有实体）`);
    for (const c of evs) {
      out.push(`   - 共享 ${c.shared} 个稀有实体：${c.words.slice(0, 6).join('、')}`);
      out.push(`       ${c.a}（${c.pageA}）「${String(c.titleA).slice(0, 38)}」`);
      out.push(`       ${c.b}（${c.pageB}）「${String(c.titleB).slice(0, 38)}」`);
    }
    out.push('   → 事件边落库：`cli ev link <from> <to> --type causal|sequence|scenario`；否决的用 `cli ev drop <from> <to>`');
  }
  out.push('   → 人审：成立就给它俩建 `rel:` 边（**可标类型**：`:causal`/`:sequence`/`:scenario`/`:attribute`/`:preference`，白名单见 bank.mjs 的 REL_TYPES；标了类型的边在名额不足时优先）；否决的写进 `dream-discarded.json`（否则每天报同一批）');
  return out;
}
