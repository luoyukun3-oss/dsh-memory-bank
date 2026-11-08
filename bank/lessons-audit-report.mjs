// ============================================================================
// Memory Bank · lessons-audit-report —— 哑弹审计的**报告渲染**（2026-11-08 按域拆出）
//   拆分原因：`budgets.json` 的架构红线（lessons-audit 预算 90 行），加了"口径说明 + 索引过期
//   + 序号漂移"三条告警后实测 113 行 ⇒ 按域拆，**不靠压缩行宽硬塞**（红线文件里明写的规矩）。
//   分工：`lessons-audit.mjs` 只做**计算**（判据、口径、数据源），本文件只做**呈现**。
//   这样分开的好处是实测过的：2026-11-07 那版把两者混在一起，判据出错时"看起来还在正常输出"，
//   而 `formatDormantReport` 的措辞（"哑弹候选 N 条"）让人更信它 —— 计算错了，报告越工整越危险。
// ============================================================================

/** 渲染哑弹报告（纯函数：只吃 auditLessons 的返回值）。 */
export function formatDormantReport(r, { days = 30 } = {}) {
  const out = [];
  out.push(`【教训哑弹审计】条目 ${r.total} 条（口径＝index.json 的 lessons 条目）｜超过 ${days} 天观察期 ${r.counted} 条｜哑弹候选 ${r.dormant.length} 条`);
  out.push('（判据：条目写成后 30 天内零命中 —— 主召回与 cue 联想都不曾带出它。**只报告不删**，人工裁决后用 `prune --page lessons.md` 退役）');
  if (r.staleIndex) out.push('⚠️ **index.json 可能过期**：lessons.md 比索引新 ⇒ 新写的条目不在本次统计里。先跑 `cli init` 或 `reindexPage` 再审计。');
  if (r.driftKeys) out.push(`⚠️ access 里有 ${r.driftKeys} 个键指向已不存在的条目序号（序号漂移/条目被删的痕迹）⇒ 个别条目的命中历史可能错位到邻居。`);
  if (!r.dormant.length) { out.push('✅ 没有哑弹候选 —— 所有过了观察期的教训都至少被看见过一次。'); return out; }
  out.push('');
  for (const d of r.dormant.slice(0, 40)) {
    out.push(`  · ${d.id}${d.n ? `（L${d.n}）` : ''}（${d.ageDays} 天前写）${d.title}`);
  }
  if (r.dormant.length > 40) out.push(`  …另有 ${r.dormant.length - 40} 条（用 \`--json\` 导出全部）`);
  out.push('');
  out.push('⚠️ 裁决前先 `recall` 该条关键词复核 —— 「零命中」只说明没被检索带出过，不等于内容无用（可能只是没人问到）。');
  return out;
}
