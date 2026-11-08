#!/usr/bin/env node
// inbox 投递门回测：用 discarded.json 的历史噪音，验证 scoreCandidate 的挡 / 留效果。
//
// 用途 —— **调参**。改了 bank.mjs 里的 `scoreCandidate` 或 `INBOX_GATE` 之后跑这个看效果：
//   ① **挡下率**：越高越好（说明噪音被拦住）
//   ② **保留明细**（关键！）：逐条看留下的到底该不该留 ——
//      **误伤真知识比漏挡噪音更糟**，所以这一节才是调参的主要依据。
//
// 数据来源：`discarded.json` 是历次「我判断后丢弃」的候选指纹 —— **天然是一份标注好的噪音集**
//   （35 条，含提问 / 任务书 / 汇报 / 报错原文 / 真偏好重复 等各类）。
//
// 单一真相源：直接 import bank.mjs 的 scoreCandidate / INBOX_GATE，
//   避免"回测脚本和实现各写一份、改了一边忘另一边"（2026-09-18 首版就写在临时脚本里，已合并）。
//
// 用法：
//   node inbox-gate-backtest.mjs          # 用 bank.mjs 当前的 INBOX_GATE
//   node inbox-gate-backtest.mjs 0.7      # 试别的门槛（调参用，不改实现）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCandidate, INBOX_GATE } from '../bank/bank.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISCARDED = path.join(HERE, '..', 'repos', 'e-2', 'discarded.json');
const THRESHOLD = process.argv[2] ? Number(process.argv[2]) : INBOX_GATE;

const { items } = JSON.parse(fs.readFileSync(DISCARDED, 'utf8'));

console.log(`回测集：${items.length} 条历史噪音（discarded.json，全部标注为「已判断·该丢」）`);
console.log(`门槛：${THRESHOLD}${process.argv[2] ? '（命令行覆盖）' : '（取自 bank.mjs 的 INBOX_GATE）'}\n`);

const kept = [];
let drop = 0;
for (const it of items) {
  const sc = scoreCandidate(it);
  if (sc >= THRESHOLD) kept.push({ sc, it });
  else drop++;
}

for (const { sc, it } of kept) {
  console.log(`  ${sc.toFixed(2)}  保留  ${it.slice(0, 62)}`);
}

console.log(`\n统计：挡下 ${drop} / 保留 ${kept.length}（共 ${items.length}）  挡下率 ${((drop / items.length) * 100).toFixed(0)}%`);
if (kept.length) {
  console.log('\n↑ 上面这些是「本应丢弃却被保留」的 —— 逐条看：');
  console.log('  · 只是重复的**真偏好/真知识** ⇒ 可接受（去重由 prev.includes 那道防线负责）');
  console.log('  · 若确实是噪音 ⇒ 说明 scoreCandidate 缺特征，去 bank.mjs 补 ①~⑥ 中的某条');
}
