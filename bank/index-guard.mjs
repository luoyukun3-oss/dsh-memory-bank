// ============================================================================
// Memory Bank · index-guard —— 索引写后自检（2026-11-08）
//
// 抄自 LivingMemory 两处机制，都与存储实现无关：
//   ① `index_validator_rebuild.py` 的「影子 + 原子切换 + `if not switched: DROP shadow`」
//      —— 配合我们已改的原子 `writeJson`（core.mjs），保证写到一半崩不会留半成品。
//   ② `memory_engine_batch.py` 的「**跨系统写完立刻回读比对，不一致就抛错**」：
//          deleted = await delete_documents(ids)
//          if set(deleted) != set(ids): raise RuntimeError(...)
//      调研实测：我们全库只有 `commands/ev.mjs:78` 一处**注释**提过「回读确认」，没有任何通用校验。
//
// 为什么必须有（两起真实事故都是"写完没回读、靠事后体检才发现"）：
//   · `index.json` 的 docs 数从 **2288 悄悄掉到 1056**（去重），没人当场发现；
//     等 `recall-eval` 的相关触发从 15/18 掉到 11/18 才追出来，还差点被归因成"检索代码改坏了"。
//   · `journal/` 里 **24.3% 是重复段**（476 KB / 1.87 MB），同样是事后扫才看见。
//
// ⚠️ 判据阈值取 **±30%**，不是拍的：正常增删是"加几条 / 删几条"，
//   而 2288→1056 是 **-54%**，重复段清理是 -50% 量级 —— 真事故都远超 30%。
//   下限 `prev >= 20` 是为了避开「空库首次建索引」这种从 0 到 N 的正常增长。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { nowIso, readJson, writeJson } from './core.mjs';
import { stampIndex } from './index-schema.mjs';   // 写前打标：schemaVersion + stats（2026-11-08）

/** 单次写入把索引总量改掉超过这个比例，就当异常记录一条。 */
export const SHIFT_ALERT_RATIO = 0.3;

/** 读当前索引条数（文件不存在或坏掉都返回 0，绝不抛）。 */
export function indexCount(dir) {
  const j = readJson(path.join(dir, 'index.json'), { docs: [] });
  return Array.isArray(j.docs) ? j.docs.length : 0;
}

/**
 * 写索引 + 自检。**三个写入口（reindexPage / indexDoc / indexDocs）统一走这里**，
 * 别再单独调 `writeJson(index.json)` —— 那样等于绕过自检。
 *
 * @param {string} dir 仓库目录
 * @param {object} idx 完整索引对象
 * @returns {number} 写入后的条数
 */
export function commitIndex(dir, idx) {
  const f = path.join(dir, 'index.json');
  const prev = indexCount(dir);
  // 写前打标：补 schemaVersion + stats（自描述，供 verifyIndex 事后对照）
  const stamped = stampIndex(idx);
  const want = Array.isArray(stamped.docs) ? stamped.docs.length : 0;

  writeJson(f, stamped);

  // ① 回读比对：写进去的必须能读回来、且条数一致。
  //    抓的是「序列化异常 / 并发覆盖 / 磁盘问题」—— 这些都不会抛错，只会静默变成别的样子。
  const back = readJson(f, null);
  const got = back && Array.isArray(back.docs) ? back.docs.length : null;
  if (got !== want) {
    throw new Error(`索引写后回读不符：期望 ${want} 条，读回 ${got === null ? 'null（文件读不回来或不是合法 JSON）' : got + ' 条'}｜${f}`);
  }

  // ② 条数突变：单次写入改掉 ±30% 以上，大概率是 bug 而不是正常增删。
  //    ⚠️ 只**记录 + 喊一声**，不抛错 —— 清理重复那种操作确实会大幅减少，
  //    那是合法的；要的是"让它别悄悄发生"，不是"禁止它发生"。
  if (prev >= 20 && Math.abs(want - prev) / prev > SHIFT_ALERT_RATIO) {
    const pct = Math.round(((want - prev) / prev) * 100);
    const alertFile = path.join(dir, 'state', 'index-alerts.json');
    try {
      const list = readJson(alertFile, { items: [] });
      const items = Array.isArray(list.items) ? list.items : [];
      items.push({ at: nowIso(), before: prev, after: want, pct });
      writeJson(alertFile, { items: items.slice(-50) });   // 只留最近 50 条，别让告警自己变成大文件
    } catch { /* 记不上告警也不能拖垮写入本身 */ }
    try {
      process.stderr.write(`[memory-bank] ⚠️ 索引条数突变 ${prev} → ${want}（${pct > 0 ? '+' : ''}${pct}%），已记 ${alertFile}\n`);
    } catch { /* hook 里 stderr 不可写时静默 */ }
  }

  return want;
}

/** 读最近的索引告警（给 tick / 诊断工具用）。 */
export function readIndexAlerts(dir, limit = 10) {
  const list = readJson(path.join(dir, 'state', 'index-alerts.json'), { items: [] });
  const items = Array.isArray(list.items) ? list.items : [];
  return items.slice(-limit);
}

/** 告警文件是否存在且非空（tick 可以据此在摘要行里加一个 ⚠️）。 */
export function hasIndexAlerts(dir) {
  try { return fs.statSync(path.join(dir, 'state', 'index-alerts.json')).size > 20; } catch { return false; }
}
