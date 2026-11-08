// handoff「空泛小结降级」的验收测试（2026-11-08 按域拆出）。
// 拆分原因：`budgets.json` 的红线（test-handoff 预算 120），加完本节实测 141 ⇒ 按域拆，不压行宽。
//
// 守什么：handoff 里曾连续三轮写成「这一轮已经完成。」「继续推进发布准备。」「试用了智能团队，效果不错。」
// —— 占着注入预算、零信息量。判据 = 首段 ≤16 字 且 无数字 且 无代码/路径 ⇒ 降级成「（进度播报，无结论）」。
//
// ⚠️ 判据是**回放标定**出来的，不是拍的（全库 281 会话 / 12588 条 assistant 正文，命中 17.3%）：
//   · 试过放宽到 18/20 字 —— 17~20 字档里「上一步的写入没有生效，脚本文件不存在」是**真结论**，
//     放宽就误伤 ⇒ **保持 16**，宁可漏几条（漏的会以标记形式出现，不会消失）；
//   · 试过把「含英文术语 / 含冒号 / 含书名号」当保留信号 —— 三个全被实测否掉
//     （抓到的是「跑 tick 收尾」「更新待办：把这一项标记完成」）⇒ 不加。
import { formatHandoff, isThinMine } from './handoff.mjs';

export function runHandoffThinTests({ ok }) {
  console.log('== 3g. 空泛小结降级（2026-11-08 新增，从 test-handoff 拆出） ==');

  ok(isThinMine('这一轮已经完成。'), '「这一轮已经完成。」判为空泛（8 字、无数字）');
  ok(isThinMine('继续推进发布准备。'), '「继续推进发布准备。」判为空泛');
  ok(isThinMine('试用了智能团队，效果不错。'), '「……效果不错。」判为空泛');

  ok(!isThinMine('哑弹候选 203→14（旧实现拿文件行号当 access 键）。'),
    '带数字的短句**不**降级（防误杀实测结论）');
  ok(!isThinMine('`handoff.mjs` 已改。'), '带代码标记的不降级');
  ok(!isThinMine('上一步的写入没有生效，脚本文件不存在。'),
    '17 字的真结论不降级（这就是不放宽到 18 的理由）');

  const thinOut = formatHandoff([
    { user: '继续做规范化', mine: '这一轮已经完成。', at: Date.now() },
    { user: '然后呢', mine: '哑弹候选 203→14。', at: Date.now() + 1 },
  ], { label: 'test-thin' });
  ok(/进度播报，无结论/.test(thinOut.text), '端到端：空泛小结渲染成「（进度播报，无结论）」');
  ok(thinOut.text.includes('哑弹候选 203→14'), '端到端：有信息的小结原样保留');
  ok(thinOut.rowChars < 200, `降级后正文更短（行合计 ${thinOut.rowChars} 字）`);
  ok(thinOut.turns === 2, '降级不丢轮次（保住「这轮发生过」这个事实）', String(thinOut.turns));
}
