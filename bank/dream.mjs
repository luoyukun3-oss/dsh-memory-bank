// 做梦：发现「未被注意的关联」—— 找**没有共享标签、却共享罕见词（高 idf）**的条目对。
// ============================================================
// 为什么叫"做梦"：凝缩 = 合并同类项（已有 rel: 边/分组在做）；**做梦 = 发现意外关联** ——
//   两个条目在**标签维度毫无交集**，却在内容上共享一批罕见词 ⇒ 那才是标签表达不了的
//   "原来这两件事有关"。（类比人脑：梦把白天没放在一起的两件事连起来。）
//
// ⚠️ 设计原则（2026-09-17 定，2026-09-19 落地）：
//   ① **只报告、不自动改**（同 `prune` 的默认 dry-run）—— 关联的成立与否是判断，不是计算；
//   ② 人审后**成立**才建 `rel:` 边；**否决**的记入 `dream-discarded.json`，下次不再报（否则每天同一批）；
//   ③ 触发时机放 `tick`（增量摄入之后），详细清单用 `cli.mjs dream`。
//
// 判据来源与踩过的坑（2026-09-19 原型实测）：
//   - 第一版按"共享罕见词数"排序 ⇒ **733 组候选、一半是噪音**，因为 `changelog.md` 这类
//     **汇总页**什么都提过、跟谁都能撞。⇒ 改用**归一化重叠度** `shared / min(两边罕见词数)`
//     ⇒ 降到 150 组，且前排基本是真关联。
//   - 第一版还漏用了 `isNoise` ⇒ `758`、`988` 这类**数字**被当成"罕见词"混进来。
//     ⇒ 现已复用 `bank.mjs` 的 `isNoise`（顺手把它导出了）。
//   - ⚠️ 分词是**中文 bigram**（见 `tokenize`），所以词表里会出现 `认只`、`向都` 这类碎片。
//     它们**不影响判据**（碎片同样能反映同源），只是词表不好看 —— 展示时优先挑像词的。
//
// 判据（落地前的门槛，2026-09-17 记入 todos）：带 `t:` 标签的条目 ≥ 50 **或** cooccur 里
//   n≥2 的对 ≥ 20。2026-09-19 实测：**带标签 20 条**（未达）但 **cooccur 无向对 n≥2 有 292 组**
//   （远超 20）⇒ 满足"或"，可以落地。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { isNoise } from './bank.mjs';
import { findEventPairs } from './dream-events.mjs';   // 事件×事件（2026-10-27 独立域，见该文件头）

/** 罕见词的 df 上限：只跟极少数条目共有的词才算"罕见"。 */
const RARE_DF = 2;
/** 一对条目至少共享几个罕见词。 */
const MIN_SHARED = 3;
/** 归一化重叠度下限（shared / min(两边罕见词数)）—— 这一步让"汇总页"自动沉底。 */
/** 2026-10-18 由 **0.04 → 0.12** 的实测依据：当天 61 组候选经三批子代理独立审完**全部判 no**，
 *  其中 `overlap < 25%` 占 50 条（82%）、`< 12%` 占 29 条 ⇒ 0.04 这个门槛几乎没在筛东西。 */
const MIN_OVERLAP = 0.12;
/** 报告上限（人审，多了看不完）。 */
const LIMIT = 20;
/** 枢纽阈值：一个条目出现在 ≥ 这么多候选对里 ⇒ 视为「汇总页」，从报告里排除。 */
const HUB_DEGREE = 8;
/** 「状态页」不参与联想（2026-10-18 加，实测依据见文件头）。
 *  - `todos.md`：待办是「要做的事」，不是「知道的事」；它和任何知识条目的共享罕见词只说明同一件事被
 *    待办化过，不构成关联（当天 61 条里 todos 参与 17 次，审批全判 no）。
 *  - `aliases.md`：别名是「口语 → 正式术语」的映射，条目本身就是那个主题的名字 ⇒ 与主题页的配对是同义反复。
 *  - `handoff.md`：会话交接收录，同理。 */
const EXCLUDED_PAGES = new Set(['todos.md', 'aliases.md', 'handoff.md']);

const fp = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** 像"词"的优先展示：含英文/数字、或长度 ≥ 3 的中文串排在前面（纯 bigram 碎片靠后）。 */
const rank = (t) => (/[a-z0-9_]/.test(t) ? 0 : t.length >= 3 ? 1 : 2);

/** same-event 分层用的日期差（天）。从条目 title/text 前 300 字里抽 `20xx-xx-xx`；
 *  取不到日期返回 null（保守：当 far 处理，不丢）。 */
const DAY = 864e5;
const dateOf = (d) => {
  const m = `${d?.title || ''} ${d?.text || ''}`.slice(0, 300).match(/(20\d{2})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
};

/**
 * 找候选「意外关联」。
 * @param {string} dir 仓库目录
 * @param {{rareDf?:number, minShared?:number, minOverlap?:number, limit?:number}} [opts]
 * @returns {{total:number, rareWords:number, candidates:Array, discarded:number}}
 */
export function findDreamPairs(dir, opts = {}) {
  const cfg = { rareDf: RARE_DF, minShared: MIN_SHARED, minOverlap: MIN_OVERLAP, limit: LIMIT, ...opts };
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const docs = (idx.docs || []).filter((d) => d.kind === 'page' && Array.isArray(d.tokens) && d.tokens.length);
  const N = docs.length;
  const byId = new Map(docs.map((d) => [d.id, d]));

  // 已否决过的对（防止每天报同一批）
  let killed = new Set();
  try {
    killed = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'dream-discarded.json'), 'utf8')).items || []);
  } catch { /* 还没有这个文件是正常的 */ }

  const df = new Map();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);

  const inv = new Map();
  const rareOf = new Map();
  for (const d of docs) {
    const set = new Set();
    for (const t of new Set(d.tokens)) {
      if ((df.get(t) || 0) > cfg.rareDf || isNoise(t)) continue;
      set.add(t);
      if (!inv.has(t)) inv.set(t, []);
      inv.get(t).push(d.id);
    }
    rareOf.set(d.id, set);
  }

  const pairs = new Map();
  for (const [t, ids] of inv) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = fp(ids[i], ids[j]);
        if (!pairs.has(k)) pairs.set(k, []);
        pairs.get(k).push(t);
      }
    }
  }

  const candidates = [];
  for (const [k, shared] of pairs) {
    if (shared.length < cfg.minShared || killed.has(k)) continue;
    const [a, b] = k.split('|');
    const A = byId.get(a); const B = byId.get(b);
    if (!A || !B) continue;
    // —— 本地粗筛（2026-10-18 加，理由与实测见文件头）——
    // ⓪ 状态页不参与：待办/别名/交接收录不是「知识」，与任何条目的共享词都不是关联
    if (EXCLUDED_PAGES.has(A.page) || EXCLUDED_PAGES.has(B.page)) continue;
    // ① 同页不配对：一次 recall 命中某页后本来就带出该页多条 ⇒ 同页互指在检索上收益≈0。
    //    当天 61 条里同页 32 条（52%），**全部判 no**。
    if (A.page === B.page) continue;
    // ② 已有双向 rel ⇒ 跳过（2026-10-18 监工实测：本轮 3 条候选里 2 条已互指，再建只会重复 + 占名额）。
    //    ⚠️ meta.rel 是**数组** [{page,key,type}]，不是对象索引 —— 第一版写成 relA[B.page]，恒 undefined，白跑一次。
    const relOf = (d) => (d && d.meta && Array.isArray(d.meta.rel) ? d.meta.rel : []);
    if (relOf(A).some((r) => r && r.page === B.page) && relOf(B).some((r) => r && r.page === A.page)) continue;
    // 「无共享标签」才是意外关联：标签有交集说明关系已被表达过，跳过。
    const ta = Array.isArray(A.meta?.t) ? A.meta.t : [];
    const tb = Array.isArray(B.meta?.t) ? B.meta.t : [];
    if (ta.length && tb.length && ta.some((x) => tb.includes(x))) continue;
    const denom = Math.min(rareOf.get(a)?.size || 1, rareOf.get(b)?.size || 1);
    const overlap = shared.length / denom;
    if (overlap < cfg.minOverlap) continue;
    const words = [...shared].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
    const score = shared.reduce((s, t) => s + Math.log(N / (df.get(t) || 1)), 0);
    const da = dateOf(A); const db = dateOf(B);
    const dayGap = (da !== null && db !== null) ? Math.abs(da - db) / DAY : null;
    candidates.push({ key: k, a, b, shared: shared.length, overlap, score, words, dayGap,
      titleA: A.title, titleB: B.title, pageA: A.page, pageB: B.page });
  }
  candidates.sort((x, y) => y.overlap - x.overlap || y.score - x.score);
  // 枢纽过滤（2026-09-19 实测加的）：**汇总型页面**（如 `changelog.md` —— 它的内容本身就是别的
  // 条目的摘要）会与**任何**条目共享罕见词 —— 那是"必然"，不是"意外关联"。实测 20 组报告里
  // 8 组噪音**全部**来自这一个页面。判据用**度**（出现在多少候选对里）而不是硬编码页名，
  // 这样将来新增的汇总页也能自动沉下去。
  const degree = new Map();
  for (const c of candidates) {
    degree.set(c.a, (degree.get(c.a) || 0) + 1);
    degree.set(c.b, (degree.get(c.b) || 0) + 1);
  }
  const hubs = [...degree.entries()].filter(([, n]) => n >= HUB_DEGREE).sort((x, y) => y[1] - x[1]);
  const hubIds = new Set(hubs.map(([id]) => id));
  // 页头索引条目（`页#0` = 页顶那份自动生成的目录）**一律排除**：它的正文就是**全页条目的标题摘要**，
  // 于是跟任何条目都"共享罕见词" —— 纯结构性噪声。2026-10-13 人审 183 组时，6 个批次里 5 个独立报出这一型
  // （`lessons.md#0`/`faults.md#0`/`todos.md#0` 撞车），属于"该拦没拦"。与枢纽页排除同源，故并列。
  const isIndexEntry = (id) => /#0$/.test(id);
  const kept = candidates.filter((c) => !hubIds.has(c.a) && !hubIds.has(c.b) && !isIndexEntry(c.a) && !isIndexEntry(c.b));
  // same-event 分层（2026-10-13 人审 183 组实测）：候选里 **66% 是「同一天或相邻两天」**，而 6 个子智能体
  // 独立判出 **88% 属 same-event**（同一件事的多页落点：events 记经过 / lessons 记结论 / faults 记速查）。
  // 这类对用**同一个查询就会同时命中两端**，rel 扩展的 `!got.has()` 去重会把它们全挡掉 ⇒ 建边检索收益≈0。
  // ⇒ 默认只报**隔 3 天以上**（以及取不到日期、保守保留）的；同日/相邻的进 near 档，用 `--near` 另看。
  const nearList = kept.filter((c) => c.dayGap !== null && c.dayGap <= 2);
  const farList = kept.filter((c) => c.dayGap === null || c.dayGap > 2);
  // —— 「只看某天之后」档（2026-10-23 用户提议：每日 19:30 扫一遍当天，把今天发生的事连起来）——
  // 判据：候选的**任一端**条目日期 ≥ since。日期取法与 dayGap 相同（正文前 300 字抽 `20xx-xx-xx`），
  // 而 `cli remember` 写入会自动带当天日期前缀 ⇒ 「今天写的条目」天然满足，不需要另存写入时间。
  // 注意它**不复用 near 档**：near 看的是「两端的日期差小」，看的是**历史累积**的同日对；
  // since 看的是「至少一端是新的」，才能回答「今天新写的东西跟谁有关」。
  const sinceTs = cfg.since ? Date.parse(String(cfg.since)) : null;
  const freshList = sinceTs
    ? kept.filter((c) => Math.max(dateOf(byId.get(c.a)) || 0, dateOf(byId.get(c.b)) || 0) >= sinceTs)
    : null;
  const shown = freshList || (cfg.near ? kept : farList);
  // —— 事件 × 事件（2026-10-27 用户要求「事件联想也进每日联想」）——
  // 判据一样（共享稀有实体），但数据源是 memory.db、失败面也不同 ⇒ 走独立域，这里只接结果。
  const ev = findEventPairs(dir, { limit: cfg.eventLimit ?? 5 });
  return {
    total: docs.length, rareWords: inv.size, discarded: killed.size,
    eventTotal: ev.total, eventRare: ev.rareEntities, eventCandidates: ev.candidates, eventErr: ev.reason || null,
    all: shown.length, near: nearList.length, beforeHub: candidates.length,
    since: cfg.since || null, fresh: freshList ? freshList.length : null,
    hubs: hubs.map(([id]) => ({ id, degree: degree.get(id), title: byId.get(id)?.title })),
    candidates: shown.slice(0, cfg.limit),
  };
}

/**
 * 把结果格式化成 `cli.mjs dream` / `tick` 要打印的行。
 * @param {ReturnType<typeof findDreamPairs>} r
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
