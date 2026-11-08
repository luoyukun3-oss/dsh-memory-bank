// 事实键（factkey）的回归测试（2026-11-02 新增，随 bank/factkey.mjs 一起）。
// 核心要钉住三件事：
//   ① **键形状**：`对象.方面` 合法；`没有点` / `a.b.c` / 带空白 一律拒（写错键 = 假机制）
//   ② **只标旧的、不碰最新的**：同键 3 条 ⇒ 前 2 条带 sup，最后 1 条不带
//   ③ **幂等 + 不覆盖人工判断**：再跑一次不重复加注释；已带 sup 的块不当成"待标"重复处理
import { FACT_KEY_RE, findFactKeyBlocks, markSuperseded } from './factkey.mjs';

const PAGE = [
  '# notes',
  '',
  '## 事实',
  '',
  '- 2026-11-01 身高 170 <!-- key:她.身高 -->',
  '  缩进续行属于上一条。',
  '- 2026-11-02 身高 172 <!-- key:她.身高 -->',
  '- 2026-11-01 体重 50 <!-- key:她.体重 -->',
  '',
].join('\n');

export function runFactKeyTests({ ok }) {
  console.log('== 23. 事实键（factkey）：同键旧条自动 supersede（2026-11-02） ==');

  // --- ① 键形状 ---
  ok(FACT_KEY_RE.test('她.身高'), '合法键「她.身高」通过');
  ok(FACT_KEY_RE.test('我.作息'), '合法键「我.作息」通过');
  ok(!FACT_KEY_RE.test('没有点'), '缺分隔点的键被拒（否则永远匹配不上）');
  ok(!FACT_KEY_RE.test('a.b.c'), '两个点的键被拒（领域不受控）');
  ok(!FACT_KEY_RE.test('  .x'), '带空白的键被拒（parseMeta 按 \\s+ 切注释，空白会截断）');
  ok(!FACT_KEY_RE.test('她. 身高'), '含空格的键被拒');

  // --- ② 块定位 ---
  const lines = PAGE.split('\n');
  const blks = findFactKeyBlocks(lines, '她.身高');
  ok(blks.length === 2, `同键找到 2 个块（实际 ${blks.length}）`);
  ok(blks[0].e > blks[0].s, '第一个块包含缩进续行（e > s）');
  ok(findFactKeyBlocks(lines, '她.体重').length === 1, '另一个键只找到 1 个块');
  ok(findFactKeyBlocks(lines, '不存在.的').length === 0, '不存在的键找到 0 个块');

  // --- ③ 标记行为 ---
  const r = markSuperseded(PAGE, '她.身高');
  ok(r.superseded.length === 1, `2 条同键 ⇒ 标掉 1 条（实际 ${r.superseded.length}）`);
  ok(r.text.includes('170 <!-- key:她.身高 --> <!-- sup:她.身高 -->'), '旧条首行末尾追加了 sup 注释');
  ok(r.text.includes('172 <!-- key:她.身高 -->') && !r.text.split('172')[1]?.startsWith(' <!-- sup:'), '最新条**没有**被标 sup');
  ok(r.kept && r.kept.includes('172'), 'kept 指向最新那条');
  ok(r.text.includes('缩进续行属于上一条。'), '缩进续行原样保留（没被切断）');

  // --- ④ 幂等：再跑一次不重复加 ---
  const r2 = markSuperseded(r.text, '她.身高');
  ok(r2.superseded.length === 0, `幂等：第二次标 0 条（实际 ${r2.superseded.length}）`);
  ok(r2.text === r.text, '幂等：文本逐字未变');

  // --- ⑤ 只有一条时不动 ---
  const r3 = markSuperseded(PAGE, '她.体重');
  ok(r3.superseded.length === 0 && r3.text === PAGE, '只有一个键实例时不改动');

  // --- ⑥ 人工已标 sup 的块不被机器覆盖 ---
  const manual = PAGE.replace('<!-- key:她.身高 -->', '<!-- key:她.身高 sup:人工判断 -->');
  const r4 = markSuperseded(manual, '她.身高');
  ok(r4.superseded.length === 0, '已带 sup 的旧条跳过（不重复标）');

  // --- ⑦ 键不存在时完全不动 ---
  const r5 = markSuperseded(PAGE, '不存在.的');
  ok(r5.superseded.length === 0 && r5.text === PAGE, '键不存在 ⇒ 文本原样返回');
}
