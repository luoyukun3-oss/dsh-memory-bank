// ============================================================================
// Memory Bank · toc-merge —— 注入层的「纲目体·资格门」（2026-11-08，从 inject-index 拆出）
//   来源：hwshsh《大肥鱼技术手记》「一条纲要带两个目才有资格出现」的反面 ——
//   **同主题的小节不该单独占一个注入名额**。
//   实测我们的 11 节里有 2 组同主题：E0(记忆系统原则,3条)+E(记忆系统,26条)、
//   H0(错误模式总表,3条)+H0b(11条) —— 各占一行，重复花钱。
//   做法：子节整行不再输出，条目数并入父节标题（`（26，另有…` → `（26+3，另有…`）。
//   ⚠️ 只省字、不动数据：TOC 页面本身与正文行号一律不变，只是注入层的视图合并。
//   ⚠️ 不许 import bank.mjs（循环依赖）；本模块零依赖。
// ============================================================================

/** 子节 id → 父节 id。新增同主题节时在这里登记（人工判断，别按名字模糊匹配）。 */
const TOC_MERGE = { E0: 'E', H0: 'H0b' };

/**
 * 把 TOC 行里的子节合并进父节。
 * @param {string[]} toc 已剥掉 `> ` 前缀的 TOC 行
 * @returns {string[]} 合并后的行（行数减少，内容行不变）
 */
export function mergeTocSections(toc) {
  const list = Array.isArray(toc) ? toc : [];
  const rows = list.map((line) => ({
    line,
    id: (line.match(/^·\s*([A-Za-z0-9]+)\.\s/) || [])[1],
    n: (line.match(/（(\d+)/) || [])[1],
  }));
  const pairs = [];
  for (const [sub, parent] of Object.entries(TOC_MERGE)) {
    const s = rows.find((r) => r.id === sub);
    const p = rows.find((r) => r.id === parent);
    if (!s || !p || !s.n) continue;          // 父/子缺一个就不合并（宁可少省，不许错删）
    pairs.push({ subRow: s, parentRow: p, n: Number(s.n) });
  }
  if (!pairs.length) return list;
  let out = list.filter((line) => !pairs.some((x) => x.subRow.line === line));
  for (const { parentRow, n } of pairs) {
    const pat = new RegExp(`（${parentRow.n}`);
    out = out.map((line) => (line === parentRow.line ? line.replace(pat, `（${parentRow.n}+${n}`) : line));
  }
  return out;
}
