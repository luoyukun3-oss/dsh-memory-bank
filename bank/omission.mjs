// ============================================================================
// Memory Bank · omission —— 「这条为什么没被召回」（2026-09-30 新增，待办 recall 升级 ②）
//
// 出处：AAAAGENT 的 `MemoryRecallOmission`（见 `refs-memory-design.md` 第 6 节）——
//   'hard_gate' 硬门 ｜ 'no_cue' 相关性 0 ｜ 'below_threshold' 没过阈值
//   ｜ 'limit' 超 k 条上限 ｜ 'budget' 预算放不下 ｜ null
// 它那句结论值得照抄：**preview 只能回答「注入了什么」；调试召回时唯一有用的是
// 「这条为什么没被召回」** —— 我们自己就踩过：改完知识页某条不出现，只能靠猜。
//
// ⚠️ 本模块只做判定与格式化，**绝不参与打分** —— 引入它不允许改变任何召回结果，
//    验收判据就是这条：改前改后 `recall-eval.mjs` 的输出必须一致。
// ============================================================================

/** 五种理由（照抄上游分类，别自创 —— 有共同语汇才好对照彼此的调试结论）。 */
const OMISSION_KINDS = ['hard_gate', 'no_cue', 'below_threshold', 'limit', 'budget'];

/** 一句话解释每种理由（`cli explain` 的表头用）。 */
const OMISSION_LABEL = {
  hard_gate: '硬门：规则上就不许进结果（归档 / 未提炼原料 / 低置信 / 自命中）',
  no_cue: '无线索：查询词一个都没中，或只中泛词且不足 2 个',
  below_threshold: '低于阈值：算出了分，但没过 minScore',
  limit: '名额：分够了，但排在 k 名之外',
  budget: '预算：分够、名额也有，但注入额度放不下',
};

/** 按理由分组计数，顺序稳定（一眼看出"丢了多少、为什么丢"）。 */
export function summarizeOmissions(list) {
  const n = {};
  for (const o of list || []) n[o.omission] = (n[o.omission] || 0) + 1;
  return OMISSION_KINDS.filter((r) => n[r]).map((r) => `${r}(${n[r]})`).join('  ');
}

/** 明细行：`页 · 分数 · 标题 —— 补充说明`。 */
function formatOmission(o) {
  const sc = typeof o.score === 'number' ? o.score.toFixed(2) : '—';
  const t = String(o.title || '').replace(/\s+/g, ' ').slice(0, 40);
  const head = [o.page || '（查询侧）', sc, t].filter(Boolean).join(' ');
  return head + (o.detail ? ` —— ${o.detail}` : '');
}

/** 按理由分组渲染（cli explain 用；每组最多 perKind 条，免得刷屏）。 */
export function renderOmissions(list, { perKind = 5 } = {}) {
  const lines = [];
  for (const r of OMISSION_KINDS) {
    const got = (list || []).filter((o) => o.omission === r);
    if (!got.length) continue;
    lines.push(`  ${r} —— ${OMISSION_LABEL[r]}（共 ${got.length}）`);
    for (const o of got.slice(0, perKind)) lines.push('    · ' + formatOmission(o));
    if (got.length > perKind) lines.push(`    …另有 ${got.length - perKind} 条`);
  }
  return lines.join('\n');
}
