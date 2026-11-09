// ============================================================================
// Memory Bank · index-status —— 索引健康的「一行摘要」（2026-11-09 按域拆出）
//
// 为什么单独一个文件：`index-schema.mjs` 实测 118/120 行（98%，下一条就爆）。
//   按 budgets.json 的 `_principle`「只许瘦不许胖：超限先按域拆分，别压缩行宽硬塞」处理。
//
// 分工（按**读/写/展示**三段，不是按行数硬切）：
//   · `index-schema.mjs` = **写侧**：结构版本 + 打标（`stampIndex`）+ 结构校验（`verifyIndex`）；
//   · 本文件 = **展示侧**：把校验结果压成一行给人看（`cli status` 用）。
//   ⇒ 依赖方向单向：本文件 → index-schema（**反向绝不引用**，否则成环）。
//     `index-schema` 里用 re-export 保住 `bank/cli.mjs` 的 import 路径不变。
//
// ⚠️ `rebuildNote` 直接按**文件名**读 `state/index-rebuild.json`，**不 import** index-rebuild.mjs：
//   那边已经 import 了 index-guard，而 index-guard import 本文件（链条见 index-rebuild 头注释 ⑤）
//   ⇒ 从这里反向 import 会立刻成环。宁可复制一个文件名字面量，也不制造循环依赖。
// ============================================================================
import path from 'node:path';
import { readJson } from './core.mjs';
import { verifyIndex } from './index-schema.mjs';

/** 给 `cli status` 用的一行摘要。 */
export function indexStatusLine(dir) {
  const r = verifyIndex(dir);
  const ver = r.version === null ? '无版本号' : `v${r.version}`;
  const base = r.ok
    ? `索引 ${r.docs} 条 · ${ver} · stats 自洽`
    : `⚠️ 索引 ${r.docs} 条 · ${ver} · ${r.problems.length} 个问题（\`cli status\` 细看）`;
  const rb = rebuildNote(dir);
  return rb ? `${base} ｜ ${rb}` : base;
}

/**
 * 上次批量重建的落地情况（2026-11-08）：直接读 `state/index-rebuild.json`，**不 import**
 * index-rebuild.mjs（那会成环，理由见文件头）。只报不改；没有记录时返回空串。
 */
function rebuildNote(dir) {
  const j = readJson(path.join(dir, 'state', 'index-rebuild.json'), null);
  const last = j && Array.isArray(j.items) && j.items.length ? j.items[j.items.length - 1] : null;
  if (!last) return '';
  if (last.ok && !last.partial) return `上次重建 ✅ ${last.processed} 页`;
  if (last.ok && last.partial) return `上次重建 ⚠️ ${last.processed} 页成功 / ${last.failedCount} 页失败（名单见 state/index-rebuild.json）`;
  return `上次重建 ❌ 未提交（失败 ${last.failedCount}/${last.attempted}，失败率 ${Math.round((last.failureRatio || 0) * 100)}%）⇒ 线上索引未动`;
}
