// ============================================================================
// Memory Bank · lessons-audit —— 教训「哑弹」审计（2026-11-07）
//   trial 质控（借 dsh-tacit 的试用退役思路）：教训的价值要靠「被看见」的记录验证。
//   数据源 access.json（主召回 touch + 2026-11-07 起 cue 命中也 bump）。
//   判据：条目写成后 N 天内零命中 ⇒ 哑弹候选。**只报告不删** —— 判死要人判断。
//
//   ⚠️ 2026-11-08 重大修（旧实现整套判据是错的，192 条候选全是假阳性）：
//      旧实现拿**文件行号**当 access 键去查（`lessons.md#${文件行号}`），而 access.json 的键
//      是 **index.json 里的条目序号**（`core.mjs` / `index.mjs` 的 `${pageFile}#${n}`，n 跨节
//      从 0 连续递增，**不是文件行号**，且**只统计顶级 `- ` 行 + 表格行**）。
//      两条铁证（2026-11-08 实测）：
//        ① index.json 的 `lessons.md#211` 正文是「实验设计必须保证…」，而它在 lessons.md 里
//           位于**第 555 行**；第 211 行是**空行** ⇒ 键 ≠ 行号。
//        ② access 里 lessons 键**最大只有 522**，而旧审计报出的 203 条候选里有 **201 条行号
//           > 522** ⇒ 那些键**根本不存在**，必然「零命中」⇒ 必然被误判成哑弹。
//      现改法：**直接读 index.json 里的 lessons.md docs** —— 条目定义、编号、access 键三者
//      天然同源，不再自己重新实现一套切分（旧实现 regex 切出 591 条，索引只有 520 条，本来就对不上）。
//      行号现在只用于「给人看」和 `prune`，由条目正文在源文件里定位，不再参与命中判定。
//
//   ⚠️ 残留误差（已知、不掩盖）：条目序号会随前文增删**整体漂移**，而 access 里存的是写入当时的
//      序号 ⇒ 一个老键可能指向今天的新条目。这是全库既有缺陷（`core.mjs` 的注释里写明过，
//      `rel:` 因此改用关键词而非编号）。要根治得把 access 的键换成内容指纹，属独立改造，
//      不在审计这一层动。这里**只在报告里如实标注**，不假装精确。
// ============================================================================
import { loadAccess, readJson, readText } from './core.mjs';
import { countDriftKeys, isIndexStale, makeLineLocator } from './lessons-audit-diag.mjs';
import path from 'node:path';

/** 默认观察期：30 天。写成超过 30 天仍零命中的教训才算哑弹候选。 */
export const DORMANT_DAYS = 30;

/**
 * 扫 lessons.md，返回哑弹候选。
 * @returns {{total:number, dormant:Array, counted:number, staleIndex:boolean, driftKeys:number}}
 */
export function auditLessons(dir, { days = DORMANT_DAYS } = {}) {
  const pageFile = 'lessons.md';
  const idxPath = path.join(dir, 'index.json');
  const idx = readJson(idxPath, { docs: [] });
  const docs = (idx.docs || []).filter((d) => d.page === pageFile);
  const text = readText(path.join(dir, 'pages', pageFile)) || '';
  const srcLines = text.split('\n');
  const access = loadAccess(dir);
  const now = Date.now();

  // 索引新鲜度与序号漂移：辅助诊断，见 lessons-audit-diag.mjs
  const staleIndex = isIndexStale(dir, pageFile, idx);
  const driftKeys = countDriftKeys(access, pageFile, docs.length);
  const locate = makeLineLocator(srcLines);

  const dormant = [];
  let counted = 0;
  for (const d of docs) {
    // 书写时间：条目正文里的第一个日期（我们的规范：教训条目必带日期前缀）
    const m = String(d.text || '').match(/([0-9]{4}-[0-9]{2}-[0-9]{2})/);
    const ts = m ? Date.parse(m[1]) : NaN;
    const ageDays = Number.isFinite(ts) ? Math.floor((now - ts) / 86400000) : null;
    if (ageDays === null) continue;            // 无日期 ⇒ 无法定年龄，宁漏勿杀
    if (ageDays < days) continue;              // 还在观察期内
    counted++;

    const hitAt = access[d.id] || 0;
    if (hitAt > ts) continue;                  // 写成后被命中过（含 cue）⇒ 活的
    dormant.push({
      id: d.id,
      n: locate(d.text),                       // 行号仅供人看/prune 用，不参与判定
      title: String(d.title || '').slice(0, 60),
      writtenAt: ts,
      ageDays,
      hitAt,
    });
  }
  return { total: docs.length, counted, dormant, staleIndex, driftKeys };
}

/** 渲染报告 —— 实现已按域拆到 `lessons-audit-report.mjs`（行数红线），这里只做转发，保持调用方不变。 */
export { formatDormantReport } from './lessons-audit-report.mjs';
