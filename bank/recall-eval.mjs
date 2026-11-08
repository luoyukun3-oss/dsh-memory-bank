/**
 * 召回评测（常驻）：`node E:\2\_dsh_memory\bank\recall-eval.mjs`
 *
 * 为什么要有它（2026-09-15 踩过）：
 * 「加一条记录」会**改变整个检索生态** —— 写教训时逐字引用了用户的查询原句，
 * 那条教训自己就成了该查询的 top-1，把真正回答它的 `faults.md` 挤出前 5。
 * 所以**改完知识页 / 改完检索逻辑，都要重跑这里**，别假设新内容只是安静地躺着。
 *
 * 判据（两条，都要看）：
 *   ① top-1 不能是「字典 / 未提炼原料」—— 别名表和 inbox 不是答案
 *   ② 期望页要落在 top-5 —— 但 `want` 为 null 的用例表示**知识库确实没有对应知识**，
 *      那种情况下"零命中"是**诚实的空**，不算失败（别为它去调排序）
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoDir, search, recall, reindexPage, ARCHIVED_PAGES } from './bank.mjs';
import { INJECT_MIN_SCORE } from './config-keys.mjs';

const dir = repoDir(process.env.BANK_SLUG || 'e-2');

// 评测前先把 pages/*.md 全部重建索引 —— 「改完知识页忘了 reindex」是高频坑
// （`tick` 打印的"旧版记忆库已刷新"来自 auto_memory.mjs，**不重建 bank 索引**）。
// 固化进这里 ⇒ 以后只要跑评测，索引就一定是最新的。
const pagesDir = path.join(dir, 'pages');
let rebuilt = 0;
for (const f of fs.readdirSync(pagesDir)) {
  if (!f.endsWith('.md') || f.startsWith('_') || ARCHIVED_PAGES.has(f)) continue;
  reindexPage(dir, f);
  rebuilt++;
}
console.error(`# 已重建 ${rebuilt} 个知识页索引`);

// [口语提问, 期望落在哪一页（null = 库里确实没这条知识，不做断言）]
const CASES = [
  ['电脑变慢 界面发钝 风扇一直响', 'faults.md'],
  ['怎么委婉地推掉老师的邀约', null],
  ['循环次数不能填小数', 'lessons.md'],
  ['为什么老是弹窗问我要不要允许', null],
  ['业界怎么做长期记忆 调研结论', 'lessons.md'],
  ['上次改权限改成什么了', 'decisions.md'],
  ['我学 Python 学到哪了', null],
  ['成考什么时候报名', 'todos.md'],
  ['摸鱼模式怎么开', null],
  ['网页按钮点了没反应', 'faults.md'],
  ['子代理交付要验位置不只是有没有', 'lessons.md'],
  ['别名表里有哪些组', 'aliases.md'],   // 显式问字典 ⇒ 召回别名表是**对的**
];

const short = (p) => String(p).split(/[\\/]/).pop();
const NOISE = new Set(['aliases.md', 'inbox.md']);
const lines = [];
let clean = 0, expectIn = 0, expectTotal = 0;

lines.push('| 口语提问 | top-1 | 分数 | top-1 是字典/原料 | 期望页在 top-5 | top-3 页序 |');
lines.push('|---|---|---|---|---|---|');
for (const [q, want] of CASES) {
  const hits = search(dir, q, 5);
  const top = hits[0];
  const isNoise = top ? NOISE.has(short(top.page)) : false;
  if (!isNoise) clean++;
  let inTop = '—';
  if (want) {
    expectTotal++;
    const okIn = recall(dir, q, { k: 5 }).hits.some((h) => h.page === want);
    if (okIn) expectIn++;
    inTop = okIn ? `✅ ${want}` : `❌ 缺 ${want}`;
  }
  lines.push(`| ${q} | ${top ? short(top.page) : '（无命中）'} | ${top ? top.score.toFixed(2) : '—'} | ${isNoise ? '⚠️' : '否'} | ${inTop} | ${hits.map((h) => short(h.page).replace('.md', '')).join(' > ')} |`);
}

lines.push('');
lines.push(`**汇总**：top-1 不是字典/原料 = ${clean}/${CASES.length}；期望页落 top-5 = ${expectIn}/${expectTotal}`);
lines.push('');
lines.push('### 过阈明细（recall，minScore=0.45）');
for (const [q] of CASES) {
  const r = recall(dir, q, { k: 5 });
  lines.push(`- 「${q}」→ ${r.hits.length} 条：${r.hits.map((h) => `${short(h.page)}(${h.score.toFixed(2)})`).join(', ') || '（无）'}`);
}
// —— hook 阈值体检（2026-09-15 加）——
// 每次要调 `hooks/user-prompt.mjs` 的 MIN_SCORE 时重跑这里：看"相关提问触发率"与"无关提问误触发"。
// 判据：**无关提问的最高分**就是噪声地板，阈值必须明显高于它。
const HOOK_THR = INJECT_MIN_SCORE;   // ← 取自 config-keys.mjs（不再靠注释人肉对齐）
const RELATED = [
  '我网页上点按钮没动静', '页面点不动', '上不了网', '网页打不开',
  '记忆没更新', '改了没生效', '插件装不上', 'hook 报错',
  '脚本执行不了', '脚本找不到文件', '日志打不开', '网络怎么了',
  '电脑变慢 界面发钝 风扇一直响', '循环次数不能填小数',
  '成考什么时候报名', '上次改权限改成什么了',
  '怎么委婉地推掉老师的邀约', '摸鱼模式怎么开', '为什么老是弹窗问我要不要允许',
];
const IRRELATED = ['今天天气怎么样', '一加一等于几', '帮我写一首诗', '随便聊聊天吧', '哈哈哈哈', '好的我知道了', '嗯嗯', '谢谢你'];

const sim = (q, thr) => {
  const { hits, text } = recall(dir, q, { k: 4, budget: 1100 });
  const strong = hits.filter((h) => h.score >= thr);
  return { fire: strong.length > 0, len: strong.length ? text.length : 0 };
};
const relTop = RELATED.map((q) => recall(dir, q, { k: 5, minScore: 0 }).hits[0]?.score || 0);
const irrTop = IRRELATED.map((q) => recall(dir, q, { k: 5, minScore: 0 }).hits[0]?.score || 0);

lines.push('');
lines.push(`### hook 阈值体检（当前 MIN_SCORE = ${HOOK_THR}）`);
lines.push('');
lines.push('| 阈值 | 相关提问触发 | 无关提问误触发 | 平均注入字数 |');
lines.push('|---|---|---|---|');
for (const thr of [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0]) {
  const rel = RELATED.map((q) => sim(q, thr));
  const irr = IRRELATED.map((q) => sim(q, thr));
  const fired = rel.filter((r) => r.fire);
  const avg = fired.length ? Math.round(fired.reduce((a, b) => a + b.len, 0) / fired.length) : 0;
  lines.push(`| ${thr}${thr === HOOK_THR ? ' ←当前' : ''} | ${fired.length}/${rel.length} | ${irr.filter((r) => r.fire).length}/${irr.length} | ${avg} |`);
}
lines.push('');
lines.push(`噪声地板 = 无关提问最高分 **${Math.max(...irrTop).toFixed(2)}**（阈值应明显高于它）｜当前阈值余量 ${(HOOK_THR / Math.max(0.01, Math.max(...irrTop))).toFixed(1)}×`);
lines.push(`相关提问分数：${relTop.map((s) => s.toFixed(2)).sort((a, b) => b - a).join(', ')}`);

console.log(lines.join('\n'));
