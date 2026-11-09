// ============================================================================
// test-reflect-perf.mjs —— 第 39 节：reflect 的 10 次 search 共用一份索引（2026-11-09）
//
// 守四件事（前两条是底线，后两条是这次改动的正确性）：
//   ① **`search()` 默认行为逐字不变**：不传新的 `ctx` 参数时，同一批查询的**命中顺序完全一致**、
//      分数差异 < 1e-9（只允许 `Date.now()` 衰减带来的浮点末位抖动）。`search()` 在 hook 每轮
//      召回的热路径上 —— 这条红了说明改了别人的行为，必须回滚。
//   ② **`buildSearchContext()` 预载的东西就是 search 原本现场算的东西**：plain.docs 等于原来的
//      过滤口径（`!ARCHIVED && !META`）、plain.df 等于手工重算的 df。
//   ③ **传 ctx 时真的用了它**（没偷偷再读一盘）：往 ctx.docs 里塞一条伪造条目，传 ctx 能命中、
//      不传 ctx 搜不到 —— 这条同时证明了默认路径仍现场读盘。
//   ④ **`n==1` 的主题不再白跑 search**（顺带修的行为变化）：输出里不再出现 n==1 的主题；
//      同一主题当 n==2 时照常参与（证明上一条断言不是空转）。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVED_PAGES, META_PAGES, readText, tokenize } from './core.mjs';
import { buildSearchContext } from './search-context.mjs';
import { search } from './search.mjs';
import { reflect } from './reflect.mjs';
import { reindexPage } from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(HERE, '..', 'repos', 'e-2');

/** 造一个最小可跑库（pages + journal + index）。 */
function tmpBank() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-refperf-'));
  for (const d of ['pages', 'journal', 'reflections']) fs.mkdirSync(path.join(T, d), { recursive: true });
  fs.writeFileSync(path.join(T, 'pages', 'aliases.md'), '# 别名表（口语 ↔ 术语）\n\n- 卡顿 | 性能\n', 'utf8');
  fs.writeFileSync(path.join(T, 'pages', 'lessons.md'),
    '# lessons\n\n## 性能\n\n- 卡顿的判断要先看模型有没有在输出 token 卡顿 卡顿 卡顿 卡顿\n', 'utf8');
  fs.writeFileSync(path.join(T, 'pages', 'todos.md'), '# 待办\n\n- [x] 已完成的\n', 'utf8');
  fs.writeFileSync(path.join(T, 'pages', 'inbox.md'), '# inbox\n', 'utf8');
  reindexPage(T, 'aliases.md');
  reindexPage(T, 'lessons.md');
  return T;
}

export function runReflectPerfTests({ ok }) {
  console.log('== 45. reflect 的 10 次 search 共用一份索引（2026-11-09） ==');

  const hasReal = fs.existsSync(path.join(REAL, 'index.json'));

  // ① 默认行为逐字不变（最硬的断言：顺序 + 分数）
  if (!hasReal) {
    console.log(`  [SKIP] 没有真实库索引（${REAL}）—— 默认行为对比需要它`);
  } else {
    const ctx = buildSearchContext(REAL);
    // 查询集刻意覆盖不同分支：普通 / 事件意图(了什么) / 变更台账(装了什么) / 元页放行(别名) /
    // 多词长句 / 双时态(以前) —— 任何一条顺序变了都说明默认路径被改坏。
    const QS = ['上次改权限改成什么了', '最近装了什么插件', '别名表里有哪些组', '以前那个权限是什么'];
    // ⚠️ 分数里含 `Math.pow(0.995, Δt)` 的时间衰减 ⇒ 两次调用隔几十 ms 就会差 ~5e-8，
    //   那是**时间**造成的、不是本次改动。所以把 `Date.now` 冻住再比，才谈得上"逐字相同"。
    const freeze = (fn) => {
      const real = Date.now;
      Date.now = () => 1794200000000;
      try { return fn(); } finally { Date.now = real; }
    };
    for (const q of QS) {
      const a = freeze(() => search(REAL, q, 8));
      const b = freeze(() => search(REAL, q, 8, ctx));
      const sameOrder = a.length === b.length && a.every((h, i) => h.id === b[i].id);
      ok(sameOrder, `「${q}」命中顺序逐字相同（${a.length} 条）`);
      const strictlyEqual = a.every((h, i) => h.score === b[i].score && (h.rank ?? null) === (b[i].rank ?? null));
      ok(strictlyEqual, `「${q}」分数/rank 完全相同（冻住 Date.now 后逐位相等，不是"近似"）`);
      // ⚠️ 刻意**不**加"不冻时间时顺序也一致"的断言：搜索分数里含 `0.995^Δt` 衰减，
      //   不冻时间时两条相邻条目本就会随毫秒差换位（实测差 1e-7 量级），那测的是时钟不是本次改动。
      //   要证明"默认路径没变"，上面两条（顺序 + 冻时间后逐位相等）已经是最硬的证据。
    }
    // ② 预载内容 == 原来现场算的内容
    const raw = JSON.parse(fs.readFileSync(path.join(REAL, 'index.json'), 'utf8')).docs;
    const wantPlain = raw.filter((d) => !ARCHIVED_PAGES.has(d.page) && !META_PAGES.has(d.page));
    ok(ctx.plain.docs.length === wantPlain.length && ctx.plain.docs.every((d, i) => d.id === wantPlain[i].id),
      `plain.docs == 原过滤口径（${wantPlain.length} 条）`);
    const manual = new Map();
    for (const d of ctx.plain.docs) for (const t of new Set(d.tokens || [])) manual.set(t, (manual.get(t) || 0) + 1);
    ok(ctx.plain.df.size === manual.size && [...manual].every(([k, v]) => ctx.plain.df.get(k) === v),
      `plain.df == 手工重算（${manual.size} 个词，计数逐个相同）`);
    const wantMeta = raw.filter((d) => !ARCHIVED_PAGES.has(d.page));
    ok(ctx.meta.docs.length === wantMeta.length, `meta.docs == 放行元页的口径（${wantMeta.length} 条，懒算也算得出来）`);
  }

  // ③ 传 ctx 时真用了它（伪造条目只在 ctx 里存在）
  {
    const T = tmpBank();
    try {
      const ctx = buildSearchContext(T);
      const fake = { id: 'zzz.md#7', page: 'zzz.md', kind: 'page', title: '探针唯一词甲乙丙', text: '探针唯一词甲乙丙', tokens: tokenize('探针唯一词甲乙丙') };
      ctx.plain.docs.push(fake);
      const withCtx = search(T, '探针唯一词甲乙丙', 5, ctx).some((h) => h.id === 'zzz.md#7');
      const withoutCtx = search(T, '探针唯一词甲乙丙', 5).some((h) => h.id === 'zzz.md#7');
      ok(withCtx, '传 ctx ⇒ 用的是 ctx 里的 docs（伪造条目能命中，说明没再读盘）');
      ok(!withoutCtx, '不传 ctx ⇒ 仍现场读盘（伪造条目搜不到）—— 默认路径没被改');
      // 元页两条路径：带「别名」的查询才放行 aliases.md
      const hitMeta = search(T, '别名表', 10, ctx).some((h) => h.page === 'aliases.md');
      const quiet = !search(T, '甲乙丙', 10, ctx).some((h) => h.page === 'aliases.md');
      ok(hitMeta && quiet, '元页放行仍按查询词判定（懒算的 meta 那套算对了）');
    } finally {
      fs.rmSync(T, { recursive: true, force: true });
    }
  }

  // ④ n==1 的主题不再白跑 search（顺带修的行为变化）
  {
    const T = tmpBank();
    try {
      const jf = path.join(T, 'journal', '2026-11-09.md');
      // 一条消息 ⇒ 「卡顿」组 n=1
      fs.writeFileSync(jf, '# 会话流水\n\n## 会话 probe\n\n- **[用户]** 2026/11/09 12:00:00 卡顿得很厉害\n', 'utf8');
      const r1 = reflect(T, { days: 7 });
      const out1 = readText(r1.file);
      ok(!/已记过[^\n]*卡顿/.test(out1), 'n==1 的主题不再出现在「已记过」那行（原先会白搜一次）');
      // 同一条主题做成 n=2 ⇒ 应当照常参与（证明上一句不是空转）
      fs.writeFileSync(jf, '# 会话流水\n\n## 会话 probe\n\n- **[用户]** 2026/11/09 12:00:00 卡顿得很厉害\n- **[用户]** 2026/11/09 12:05:00 还是卡顿\n', 'utf8');
      const r2 = reflect(T, { days: 7 });
      const out2 = readText(r2.file);
      ok(/已记过[^\n]*卡顿/.test(out2), '同一主题 n==2 时照常参与并出现在「已记过」那行（断言非空转）');
    } finally {
      fs.rmSync(T, { recursive: true, force: true });
    }
  }
}
