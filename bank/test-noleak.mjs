// ============================================================================
// test-noleak.mjs —— 第 28 节：测试样例不得写进知识页（防自污染，2026-11-08）
//
// 为什么单独一条红线：
//   把评测用的**噪声查询**原文抄进 `pages/*.md` ⇒ 该查询从此「永久有命中」
//   ⇒ 噪声地板被自己抬高（实测 0.91 → 2.39）⇒ hook 的 MIN_SCORE 整套标定失效。
//   2026-11-08 一天内出现三次同类污染（详见 lessons H 节），所以从"靠自觉"改成测试守护。
//
// ⚠️ 只查 `IRRELATED`（8 条闲聊），**刻意不查 `RELATED`**：
//   RELATED 里有「摸鱼模式怎么开」这类**查询本身就是合法知识标题**的条目
//   （procedures.md:337 就是按原句建的标题）—— 一刀切会把它判成污染。
//   而 IRRELATED 是"绝不该有任何对应内容"的闲聊，查它们是安全的。
//
// ⚠️ 豁免字典与台账（aliases / changelog / archive / meta / handoff / todos-archive）：
//   按 E0 原则②「知识 / 索引 / 痕迹 三种角色必须分开」——别名表是**字典**（口语变体本就该收），
//   其余是**台账与痕迹**。豁免依据是角色定位，不是"为了让测试变绿"
//   （实测 aliases.md 含「上不了网」时 top-1 仍是 faults.md，没有抢位）。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { IRRELATED } from './eval-cases.mjs';

const EXEMPT = /^(aliases|changelog|archive|meta|handoff|todos-archive)\.md$/;

export function runNoLeakTests({ ok, repoDir }) {
  const pd = path.join(repoDir('e-2'), 'pages');
  const leaks = [];
  let scanned = 0;
  for (const f of fs.readdirSync(pd)) {
    if (!f.endsWith('.md') || EXEMPT.test(f)) continue;
    scanned++;
    const txt = fs.readFileSync(path.join(pd, f), 'utf8');
    for (const q of IRRELATED) if (txt.includes(q)) leaks.push(`${f} 含「${q}」`);
  }
  ok(leaks.length === 0,
    `知识页（${scanned} 个，字典/台账已豁免）里没有 ${IRRELATED.length} 条噪声查询原文`,
    leaks.slice(0, 3).join(' | '));
}
