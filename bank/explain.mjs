// ============================================================================
// Memory Bank · 召回诊断（2026-11-08 重写）
//
// 为什么要重写：
//   ① `cli explain` 一直是**崩的** —— 它给 `recall()` 传 `explain: true`，
//      而 `recall()` 的签名里根本没有这个参数 ⇒ `res.omitted` 永远 undefined
//      ⇒ `cli.mjs:114` 抛 TypeError（2026-11-08 实测）。
//   ② `searchDetailed()` 也只是空转发（`search.mjs:216-221` 的注释写明：
//      原实现在 2026-10-05 误回滚时丢失，一直没补回来）。
//   ⇒ 结论：我们**从来就没有可用的「为什么这条排在这里」诊断**。
//      而这正是"找到准"的前提 —— 不知道为什么排不上来，就只能瞎调。
//
// 设计取舍：
//   · **不侵入 `search()` 热路径**（那边行数红线只剩 7 行）。本文件独立调用
//     `search()` 取一个大池子，再用每条自带的 `tokens` 反推命中情况。
//   · 覆盖率/命中词是**精确**的（复用同一个 `tokenize`）；但 `idf` 用池内统计**近似**全库
//     ⇒ 稀有度一栏当参考值，不要当精确 idf。这一点在输出里明写。
// ============================================================================
import { tokenize } from './core.mjs';
import { search } from './search.mjs';
// 逐条「命中来源」（2026-11-08）：算法与诚实边界都写在那个文件头（含「cue 为什么不算来源」）。
import { basisOf, buildBasisCtx, formatBasisEvidence } from './explain-basis.mjs';

const short = (s, n = 46) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/**
 * 诊断一次查询：给出每条候选的命中词、覆盖率与低分归因。
 *
 * @param {string} dir 仓库银行目录
 * @param {string} query 查询
 * @param {{k?:number, pool?:number}} opts k=要看的条数，pool=取多大的候选池
 */
export function explainQuery(dir, query, { k = 5, pool = 40 } = {}) {
  const qTokens = tokenize(query);
  const qSet = new Set(qTokens);
  // 命中来源的上下文（别名/同义扩展词 + 旁路 cue）：纯反推，**不碰 search() 热路径**。
  const bctx = buildBasisCtx(dir, query, { cue: true });
  const hits = search(dir, query, Math.max(pool, k));
  if (!hits.length) return { query, qTokens: [...qSet], rows: [], note: '没有任何候选（连低于阈值的都没有）' };

  // 池内 df（近似全库稀有度）
  const df = new Map();
  for (const h of hits) for (const t of new Set(h.tokens || [])) df.set(t, (df.get(t) || 0) + 1);
  const N = hits.length;

  const rows = hits.map((h, i) => {
    const hTok = new Set(h.tokens || []);
    const matched = [...qSet].filter((t) => hTok.has(t));
    const coverage = qSet.size ? matched.length / qSet.size : 0;
    // 命中词的平均稀有度：df 越小越稀有（信息量越大）
    const rarity = matched.length
      ? matched.reduce((s, t) => s + Math.log(1 + N / (df.get(t) || 1)), 0) / matched.length
      : 0;
    return {
      rank: i + 1,
      page: h.page,
      score: Number(h.score) || 0,
      title: h.title,
      coverage,
      matched,
      missing: [...qSet].filter((t) => !hTok.has(t)),
      rarity: Number(rarity.toFixed(3)),
      kind: h.kind,
      basis: basisOf(h, bctx),
    };
  });

  return { query, qTokens: [...qSet], rows, note: `池=${N} 条；稀有度为池内近似 idf` };
}

/** 把诊断结果渲染成人类可读的多行文本 */
export function formatExplain(res, { k = 5 } = {}) {
  const out = [];
  out.push(`查询「${res.query}」→ 查询词 ${res.qTokens.length} 个：${res.qTokens.join(' ')}`);
  if (res.note) out.push(`（${res.note}）`);
  if (!res.rows.length) return out.join('\n');
  out.push('');
  out.push('| # | 页 | 分数 | 来源 | 旁路cue | 覆盖 | 命中词 | 稀有度 | 标题 |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of res.rows.slice(0, Math.max(k, 8))) {
    out.push(`| ${r.rank} | ${r.page} | ${r.score.toFixed(2)} | ${r.basis.bases.join('+')} | ${r.basis.cue ? `${r.basis.cue.word}(${r.basis.cue.level})` : '—'} | ${(r.coverage * 100).toFixed(0)}% | ${r.matched.join(' ') || '—'} | ${r.rarity} | ${short(r.title, 34)} |`);
  }
  out.push('');
  out.push('来源 = 凭什么在列表里：keyword 查询词直中｜alias 别名表扩展｜synonym 烘焙同义｜rel / rel2 人审边｜cooccur 同轮共现｜tag 同主题标签｜unknown 判不出来（不猜）。');
  out.push('旁路cue = 它也挂在触发词表上（括号里是词档 cue/rel/tag），但 matchCues 只被 hook 与 `cli cue` 调用、**不参与 search 排序** ⇒ 它不算来源。');
  // 归因：前 k 名里覆盖率最高 / 被什么挤掉
  const top = res.rows.slice(0, k);
  const best = res.rows.reduce((a, b) => (b.coverage > a.coverage ? b : a), res.rows[0]);
  if (best.coverage > 0) {
    const inTop = top.includes(best);
    out.push('');
    out.push(`覆盖率最高的是 #${best.rank} ${best.page}（${(best.coverage * 100).toFixed(0)}%${inTop ? '，已在 top-k' : '，**没进 top-k**'}）`);
    if (!inTop) {
      out.push(`⇒ 它输在分数：${best.score.toFixed(2)} vs top-${k} 最低 ${top[top.length - 1].score.toFixed(2)}（覆盖率不等于分数，长条目/词频会放大）`);
    }
  }
  for (const line of formatBasisEvidence(res.rows)) out.push(line);   // 扩展词证据 + 联想入口统计
  return out.join('\n');
}
