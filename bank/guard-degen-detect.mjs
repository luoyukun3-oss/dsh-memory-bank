// 「被 guard 拦下的推理退化」判据（2026-10-12 新增）
// ============================================================
// 为什么需要它（2026-10-12 用户问「上个会话好像又退化了」时查实）：
//   `@argszero/cordis-plugin-empty-response-guard` 挂在 `llm/stream` 瀑布流上，
//   一旦一次完成是「只有 reasoning、无正文无工具调用」，它在**流层**就把 `stop`
//   改写成 `error(EMPTY_RESPONSE)` ⇒ 由 `dsh-llm-retry` 接住重试。
//   ⇒ 那次调用**不再写 `assistant/message`**，只留 `assistant/attempt`（失败原因）
//      + `llm/retry`（重试决定）。而 `auditDegenerate`（⑤ 段）与
//      `tools/reasoning-only-audit.mjs` 都扫 `assistant/message` ⇒ **必然报 0 条**。
//   实测：2026-10-12 当天 `harness.log` 有 11 条 guard warn（11:38:49→11:51:32），
//         而 `cli sweep` ⑤ 段报「0 条」—— 不是没病，是工具的眼睛被守卫蒙上了。
//
// 判据（两条都必须满足）：
//   ① `assistant/attempt` 的 `finish.kind === 'error'` 且
//      `finish.reason.failure.code === 'EMPTY_RESPONSE'`；
//   ② `usage` 有值 —— 有 usage ⇒ 模型确实跑过（这是**退化**）；
//      无 usage ⇒ 更像**流中断**（处方相反，别混报，同 `auditDegenerate` 的 kind 分账）。
//
// ⚠️ 上下文规模用 `usage.totalTokens`：`inputTokens` 只是**缓存未命中**那部分，
//   实测同一条 `inputTokens=169` 而 `totalTokens=182,580`（差三个数量级）。
//
// 本模块**纯判据**（与 slope-detect / frag-detect 同构：不读盘、只吃 recs），
// 集成在 `degenerate-audit.mjs` 已读过的 recs 上（避免 sweep 重复解压会话日志）。
// ============================================================

/**
 * 从一份会话记录里挑出「被 guard 拦下的推理退化」。
 * @param {Array<object>} recs 已解析的会话记录（`session.v*.jsonl` 的每一行）
 * @returns {{count:number, hits:Array<object>, providers:string}}
 */
export function detectGuardDegenerate(recs) {
  const hits = [];
  const providers = new Set();
  for (const r of recs) {
    if (r.type === 'llm/retry' && r.data?.provider) providers.add(r.data.provider);
    if (r.type !== 'assistant/attempt') continue;
    const stream = Array.isArray(r.data?.stream) ? r.data.stream : [];
    let usage = null;
    let finish = null;
    let reasonChars = 0;
    for (const item of stream) {
      const c = item.chunk ?? item;
      if (c.type === 'usage') usage = c.usage;
      else if (c.type === 'finish') finish = c.reason;
      // ⚠️ 实测（2026-10-12，那场退化的 assistant/attempt）：思考不是 `reasoning-delta`，
      //   而是 `reasoning-chunks`（`texts: string[]` 逐片段文本 + `dt: number[]` 时间间隔）——
      //   只认 `reasoning-delta` 会统计成 0 字（第一次接进 sweep 时就报了「思考最多 0 字」）。
      else if (c.type === 'reasoning-delta') reasonChars += (c.text || '').length;
      else if (c.type === 'reasoning-chunks') reasonChars += (c.texts || []).join('').length;
    }
    if (finish?.kind !== 'error' || finish.failure?.code !== 'EMPTY_RESPONSE') continue;
    const u = usage || {};
    hits.push({
      time: r.time,
      turn: r.data?.turn,
      step: r.data?.step,
      reasonChars,
      ctxTokens: u.totalTokens ?? ((u.inputTokens || 0) + (u.cacheReadTokens || 0)),
      hasUsage: usage !== null,
    });
  }
  return { count: hits.length, hits, providers: [...providers].join(',') };
}

/**
 * 把一类判据的结果压成 `cli sweep` 的一行（打印留在本模块，cli 只留一行调用 —— 同 degenerate-audit 的先例）。
 * @param {{count:number, hits:Array<object>, providers:string}} g `detectGuardDegenerate` 的结果
 * @param {string} scope 扫描范围说明（文件数/窗口），用于"没报 ≠ 没有"
 * @returns {string}
 */
export function guardLine(g, scope = '') {
  const tail = scope ? `（扫描范围：${scope}）` : '';
  if (!g || !g.count) return `   ↳ guard 拦下的退化（EMPTY_RESPONSE，只写在 assistant/attempt）：✅ 0 条${tail}`;
  const ctxs = g.hits.map((h) => Math.round((h.ctxTokens || 0) / 1000)).filter((n) => n > 0);
  const ctxRange = ctxs.length ? `ctx≈${Math.min(...ctxs)}~${Math.max(...ctxs)}k` : 'ctx 未知';
  const reasonMax = Math.max(...g.hits.map((h) => h.reasonChars));
  const first = g.hits[0];
  const noUsage = g.hits.filter((h) => !h.hasUsage).length;
  return `   ↳ ⚠️ guard 拦下的推理退化 **${g.count} 条**（首条 t${first.turn}/${first.step}｜${ctxRange}｜思考最多 ${reasonMax} 字`
    + `${g.providers ? `｜provider=${g.providers}` : ''}${noUsage ? `｜⚠️ ${noUsage} 条无 usage（更像流中断）` : ''}）`
    + ' —— 这类**不写 `assistant/message`**，上面 ⑤/⑤b 与 `reasoning-only-audit.mjs` 都看不见；处置同 ⑤（出现就连中，立刻开新会话）' + tail;
}
