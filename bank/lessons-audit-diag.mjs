// ============================================================================
// Memory Bank · lessons-audit-diag —— 哑弹审计的**诊断辅助**（2026-11-08 按域拆出）
//   拆分原因：`budgets.json` 红线（lessons-audit 预算 90 行），修 bug 后实测 98 行 ⇒ 按域拆，
//   不压缩行宽。这三件事都是「为了让报告可信而做的辅助」，与判据本身无关：
//     ① **索引新鲜度**：源文件比 index.json 新 ⇒ 新条目压根没进统计，报告会漏报。
//     ② **序号漂移**：access 里存在指向「已不存在的条目序号」的键 —— 这是全库既有缺陷
//        （`core.mjs` 注释写明：id 是 `${页}#${第几条}`，前面增删就整体错位）。如实标出来，
//        不假装精确。
//     ③ **行号定位**：条目在源文件里的行号，**仅供人看与 `prune` 用，不参与命中判定**
//        —— 2026-11-07 的 bug 正是把它当成了 access 键。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { parseMeta } from './core.mjs';

/** 源文件是否比索引新（true ⇒ 报告可能漏掉新写的条目）。拿不到时间就当不陈旧。 */
export function isIndexStale(dir, pageFile, idx) {
  try {
    return fs.statSync(path.join(dir, 'pages', pageFile)).mtimeMs > (Date.parse(idx.updatedAt) || 0);
  } catch { return false; }
}

/** access 里指向已不存在序号的键数（条目被删 / 序号整体漂移的痕迹）。 */
export function countDriftKeys(access, pageFile, docCount) {
  const maxSeq = docCount - 1;
  return Object.keys(access)
    .filter((k) => k.startsWith(`${pageFile}#`))
    .map((k) => Number(k.split('#')[1]))
    .filter((n) => Number.isFinite(n) && n > maxSeq).length;
}

/**
 * 做行号定位器：给定源文件行数组，返回 `locate(doc)` —— 只**顺序向前**找（游标单调推进），
 * 避免同一段文本被前文重复命中时来回跳。
 * ⚠️ 纯展示用：定位失败返回 0，绝不拿它当判定依据。
 */
export function makeLineLocator(srcLines) {
  let cursor = 0;
  return function locate(docText) {
    const first = String(docText || '')
      .split('\n')
      .find((l) => /^\s*(?:[-*]\s+\S|\|)/.test(l)) || '';
    const probe = parseMeta(first).cleaned.replace(/^\s*[-*]\s+/, '').trim().slice(0, 20);
    if (!probe) return 0;
    for (let i = cursor; i < srcLines.length; i++) {
      if (srcLines[i].includes(probe)) { cursor = i; return i + 1; }
    }
    return 0;
  };
}
