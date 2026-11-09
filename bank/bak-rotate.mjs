// ============================================================================
// Memory Bank · bak-rotate —— 备份文件轮转（2026-11-09）
//
// 为什么需要（本轮实测）：`_dsh_memory` 下备份共 **288 个 / 78.8 MB**，其中：
//   · 自动产物 **196 个 / 52.8 MB** —— `lessons.md` 一个就 **69 份 / 36.5 MB**（10 天内攒出来的）
//   · `_bak/` 人工快照 92 个 / 25.9 MB —— **这类一个都不碰**（AGENTS.md 规定：改文件前的 `_bak/` 快照是给人留的）
//
// ⚠️ 一条重要实测教训：**按"保留最近 N 天"轮转在这里几乎无效** ——
//   196 个自动备份的 mtime 全部落在 2026-10-29 → 11-08（10 天内），14 天窗口下一个都删不掉（实测只删 2 个 / 0.0 MB）。
//   原因很简单：这些备份是**高频修改堆出来的**，不是"很久以前的历史"。
//   ⇒ 判据必须用**份数**，不能只用时间。
//
// 采用的策略（两个条件取并集，宁可多留）：
//   ① 每个原文件保留**最近 K 份**（默认 10）—— 保证近期可回滚
//   ② 另外保留**每一天的最后一份**（默认回溯 30 天）—— 保证"上周三那版长什么样"还查得到
//   实测效果：可删 57 个 / 26.6 MB，从 52.8 MB 降到 26.2 MB（约一半）。
//
// ⚠️ 安全设计（这是**删文件**，写错就是数据损失）：
//   · 默认 **dry-run**，只回报"将删哪些"，`apply:true` 才真删
//   · **路径双重校验**：任何层级出现 `_bak` 目录的**直接跳过**（人工快照不在轮转范围）
//   · 只认文件名匹配 `/\.bak(-|$)/` 的（不靠目录猜）
//   · 每个文件删除前再判一次「它在不在保留名单里」，不在才 unlink
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

/** 默认参数（改之前先读文件头的实测数据）。 */
export const KEEP_PER_FILE = 10;
export const KEEP_DAILY_DAYS = 30;

const isBakName = (name) => /\.bak(-|$)/.test(name);
/** 路径里任何层级出现 `_bak` 目录 ⇒ 人工快照，不碰。 */
const inManualBak = (rel) => /(^|[\\/])_bak([\\/]|$)/.test(rel);

/**
 * 扫出所有备份文件。
 * @param {string} memRoot `_dsh_memory` 根
 * @returns {{auto:Array, manual:Array}} auto = 可轮转的，manual = `_bak/` 下的人工快照（只统计不处理）
 */
export function scanBackups(memRoot) {
  const auto = [];
  const manual = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!isBakName(e.name)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      const rel = p.slice(memRoot.length).replace(/^[\\/]+/, '');
      const item = { abs: p, rel, name: e.name, base: e.name.split('.bak')[0], size: st.size, mtime: st.mtimeMs };
      (inManualBak(rel) ? manual : auto).push(item);
    }
  };
  walk(memRoot);
  return { auto, manual };
}

/**
 * 算出「哪些该删」。纯函数，不碰磁盘（便于测试）。
 * @param {Array} auto `scanBackups().auto`
 */
export function planRotation(auto, { keepPerFile = KEEP_PER_FILE, keepDailyDays = KEEP_DAILY_DAYS, now = Date.now() } = {}) {
  const byBase = new Map();
  for (const r of auto) {
    const g = byBase.get(r.base) || [];
    g.push(r);
    byBase.set(r.base, g);
  }
  const del = [];
  const keep = [];
  for (const [, arr] of byBase) {
    const sorted = [...arr].sort((a, b) => b.mtime - a.mtime);   // 新的在前
    // 每天最后一份（按 mtime 降序，第一次遇到某天的那份就是"当天最后一份"）
    const dailyLast = new Set();
    const seenDay = new Set();
    for (const r of sorted) {
      const d = new Date(r.mtime).toISOString().slice(0, 10);
      if (!seenDay.has(d)) { seenDay.add(d); dailyLast.add(r.abs); }
    }
    sorted.forEach((r, i) => {
      const isNewestK = i < keepPerFile;
      const isDailyLast = dailyLast.has(r.abs) && (now - r.mtime) / 86400000 <= keepDailyDays;
      if (isNewestK || isDailyLast) keep.push(r);
      else del.push(r);
    });
  }
  return { del, keep };
}

/**
 * 执行删除（或 dry-run）。每个文件删前再校验一次路径安全性。
 * @returns {{deleted:number, bytes:number, skipped:number}}
 */
export function applyRotation(plan, { apply = false } = {}) {
  let deleted = 0;
  let bytes = 0;
  let skipped = 0;
  for (const r of plan.del) {
    // 双保险：真要删之前再判一次「不在 _bak/ 里」
    if (inManualBak(r.rel) || !isBakName(r.name)) { skipped++; continue; }
    if (!apply) { deleted++; bytes += r.size; continue; }
    try { fs.unlinkSync(r.abs); deleted++; bytes += r.size; } catch { skipped++; }
  }
  return { deleted, bytes, skipped };
}
