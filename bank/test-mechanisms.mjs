// 2026-09-21 新增机制的测试（原 test.mjs 第 18 / 19 节，2026-09-21 拆出）。
// 为什么拆：test.mjs 当时已 340/350（97%）逼近红线，按 `budgets.json` 的规矩
// 「只许瘦不许胖：超限先把功能按域拆出去、别压缩行宽硬塞」。这两节的共同点是
// 「**2026-09-21 当天新增的机制**」（主干同步 `--only` / `rel:` 边的类型），
// 与主文件里那些通用断言（解析 / 检索 / 评分 / 红线）不同域。
//
// ⚠️ 设计：`ok` 由**主文件传入** —— 子模块不自己计数、不自己 exit，
// 这样「103 项通过」这个总数仍在 test.mjs 一处汇总（拆分前后断言数必须相等，
// 这是本次拆分的验收判据：数量变了就说明有断言在搬运中丢了）。
import fs from 'node:fs';
import path from 'node:path';
import { syncFromMemory, parseMeta, rankRelTargets } from './bank.mjs';

export function runMechanismTests({ ok, real, memRoot }) {
  console.log('== 18. 主干同步：--only 过滤 + tick 报告行（2026-09-21） ==');
  // 起因：sync 报 3 处漂移，而方向各不相同（environment 双向、faults/changelog 页面新）
  // ⇒ 一把 --apply 必错。加了 only 就必须有断言守护，否则「看起来支持逐页、实际全页覆盖」
  // 这种回归没人发现 —— 而它恰恰会静默删掉页面独有行（本次差点发生）。
  const onlyOne = syncFromMemory(real, { apply: false, only: ['faults.md'] });
  ok(onlyOne.report.length === 1 && onlyOne.report[0].page === 'faults.md', 'only 只处理指定页（不波及其它 4 处）');
  const onlyTwo = syncFromMemory(real, { apply: false, only: ['faults.md', 'changelog.md'] });
  ok(onlyTwo.report.length === 2, 'only 支持逗号多页（CLI 侧按 "," 切分）');
  // 2026-10-23：tick 主流程搬到 commands/tick.mjs。判据改成「两段关键文本都在」，**不绑拼接语法**
  // （原判据写死 `/主干同步：\$\{r5\.ok/`，而那行现在是字符串拼接 ⇒ 改一次写法就假红）。
  const tickSrc = fs.readFileSync(path.join(memRoot, 'bank', 'commands', 'tick.mjs'), 'utf8');
  ok(/主干同步/.test(tickSrc) && /r5\.ok/.test(tickSrc), 'tick 汇总行带主干同步状态（漂移不再静默累积）');

  console.log('== 19. 关联边的类型（rel: 第三段 · 2026-09-21 借 Ariadne） ==');
  // 起因：rel: 边只有"相关"没有语义（Ariadne 有 7 类边、权重 0 表示该方向阻断）。加类型必须
  // **向后兼容**（库里已有 40 条无类型边），且**末段不是白名单词时不能吞掉关键词**。
  const rA = parseMeta('- x <!-- rel:faults.md:hook完全不注入 -->').meta.rel;
  ok(rA.length === 1 && rA[0].key === 'hook完全不注入' && !rA[0].type, '旧格式（无类型）原样解析，type 为空');
  const rB = parseMeta('- x <!-- rel:faults.md:hook完全不注入:scenario -->').meta.rel;
  ok(rB[0].key === 'hook完全不注入' && rB[0].type === 'scenario', '新格式解析出类型，且关键词里不含类型词');
  ok(parseMeta('- x <!-- rel:lessons.md:causal -->').meta.rel[0].key === 'causal', '关键词本身叫 causal 时不当类型');
  ok(parseMeta('- x <!-- rel:a.md:x:未知类型 -->').meta.rel[0].key === 'x:未知类型', '非白名单末段整串当关键词（不静默吞字）');
  const rk = rankRelTargets([{ key: 'a' }, { key: 'b', type: 'causal' }, { key: 'c', type: 'sequence' }]);
  ok(rk[0].key === 'b' && rk[1].key === 'c' && rk[2].key === 'a', '名额有限时标了类型的边优先，同类型内保持原顺序');
}
