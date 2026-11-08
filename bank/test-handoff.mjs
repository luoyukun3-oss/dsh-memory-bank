// 跨会话交接（handoff）的测试 —— 原 test.mjs 的 3d2/3d3/3e 三节，2026-09-22 拆出。
// 为什么拆：test.mjs 当时已 384/350（超限 34 行），按 `budgets.json` 的规矩
// 「只许瘦不许胖：超限先**把功能按域拆出去**、别压缩行宽硬塞」（先例：test-mechanisms.mjs）。
// 这三节的共同点是「2026-09-22 当天新增的机制」，与主文件里那些通用断言（解析/检索/评分/红线）不同域。
//
// ⚠️ 设计同 test-mechanisms.mjs：`ok` 由**主文件传入** —— 子模块不自己计数、不自己 exit，
// 好让「通过/失败」总数仍在 test.mjs 一处汇总。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapText } from './bank.mjs';
import { pickTurns, oneLine, formatHandoff, writeHandoff } from './handoff.mjs';
import { HANDOFF_CHARS, HANDOFF_TURNS } from './config-keys.mjs';

export function runHandoffTests({ ok, real }) {
  console.log('== 3d2. 跨会话交接：抽轮次（2026-09-22 新增） ==');
  /**
   * 这一节守的是 handoff 的**抽取判据** —— 它没有"标准答案"，全靠实测踩出来的规矩：
   *   · 只认用户打的字（`source.kind === 'user'`）：日志里 plugin 注入的运行时快照长得像用户消息；
   *   · 纯确认/寒暄（「好的」）**不成一轮**：它之后的我方正文自然并回上一条真问题；
   *   · plugin 注入既不算一轮、也不打断归属；
   *   · 我方小结**就地回填**给当前最后一条有效轮次；同一轮多条正文取最后一段（工具调用型无正文，不覆盖）；
   *   · 表格片段不能当小结。
   *
   * ⚠️ **2026-10-31 修正**：旧注释说「别断言第一轮配到它自己的答复」，理由是"实测 session-f4b2d1d6 配对正确"。
   *    那条结论现在被真实日志回放推翻 —— 旧实现是 pending 等下一条 user 认领 ⇒ **每行都错位一格**：
   *    session-2cec5565 的「方案 A（推荐）有没有更快的方法」配的是上一轮的「本地源码在 …」；
   *    e3bba346 的「简答放进代码跨，现在复制会变颜色」配的是上一题的参考答案。
   *    ⇒ 本节的断言现在守的是**正确归属**：每轮配到它自己的答复。
   */
  const hrec = (type, data, time) => ({ type, data, time });
  const fixture = [
    hrec('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第一轮：帮我看看这个循环为什么停不下来' }] }, 1),
    hrec('assistant/message', { turn: 1, message: { content: [{ type: 'tool-call' }] } }, 2),                      // 无正文 ⇒ 不算小结
    hrec('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '主人，先把范围缩小 ⋉(･ω･)⋊ 我实测发现是条件永远为真。\n| 变量 | 值 |\n| --- | --- |' }] } }, 3),
    hrec('user/message', { source: { kind: 'plugin' }, content: [{ type: 'text', text: '当前运行时上下文。本快照取代更早的运行时上下文快照。' }] }, 4),
    hrec('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '好的' }] }, 6),               // 不成一轮，但要用掉候选
    hrec('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: '那我继续往下看，把剩下的分支也走一遍。' }] } }, 7),
    hrec('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮：那把它改成 while 加 break 行不行' }] }, 8),
    hrec('assistant/message', { turn: 3, message: { content: [{ type: 'text', text: '可以，但要注意 break 只跳出最内层。' }] } }, 9),
    hrec('assistant/message', { turn: 3, message: { content: [{ type: 'tool-call' }] } }, 10),                      // 轮末工具调用：无正文，不得清掉已回填的小结
  ];
  const hturn = pickTurns(fixture, 5);
  ok(hturn.length === 2, `合成记录抽出 ${hturn.length} 轮（plugin 快照与「好的」都不算）`, JSON.stringify(hturn.map((x) => x.user.slice(0, 6))));
  ok(!hturn.some((x) => String(x.user).includes('运行时上下文')), 'plugin 注入的运行时快照没被当成主人说话');
  ok(!hturn.some((x) => /^好的$/.test(x.user)), '纯确认「好的」不成一轮');
  ok(String(hturn[0].mine).includes('继续往下看'),
    '第一轮回填到它自己的正文（「好的」之后的答复并回这一轮 ⇒ 同一轮取最后一段）');
  ok(String(hturn[1].mine).includes('可以，但要注意') && !String(hturn[1].mine).includes('继续往下看'),
    '第二轮配到**它自己的**答复（错位会在这里红：旧实现会配到上一轮的「继续往下看」）');
  ok(String(hturn[1].mine).includes('可以，但要注意'), '轮末的工具调用（无正文）不会清掉已回填的小结');

  console.log('== 3d3. 跨会话交接：摘要清洗与预算 ==');
  ok(!oneLine('主人，先把范围缩小 ⋉(･ω･)⋊ 我实测发现是条件永远为真。', 90).includes('⋉'), '颜文字被剥掉（它占字数不产信息）');
  ok(oneLine('六刀全下完了 模块 行数 域 --- --- --- bank.mjs 401', 90) === '', '整段就是一张表时返回空，**不回退到表本身**（兜底方向必须与判据同向）');
  ok(oneLine('主人，能不能加个遗忘插件解决', 90) === '能不能加个遗忘插件解决', '剥掉「主人，」这类寒暄前缀再取句');
  // ⚠️ 这条是补的**回归断言**：真实日志里的逗号是**全角** `，`，而上面那句测例当初写的是半角
  //    ⇒ 单测绿、真实数据没剥掉（"测例的标点必须与实际数据同源"）。以下两句分别钉死全角与省略标点。
  ok(oneLine('主人，我把能找的四条路都跑了一遍', 90) === '我把能找的四条路都跑了一遍', '全角逗号同样剥掉（真实数据就是全角）');
  ok(oneLine('主人 是的，这样也行', 90) === '是的，这样也行', '标点省略时也剥（「主人 是的，…」实测形态）');
  ok(oneLine('好，我把它读了一遍。第二句不该出现。', 90) === '我把它读了一遍。', '只取首句');
  const many = Array.from({ length: 8 }, (_, i) => ({ user: `第${i}轮问题：这里有二十来个字够不够凑一轮`, mine: `第${i}轮答复：也凑上二十来个字好让预算真的起作用`, at: i + 1 }));
  const hfSmall = formatHandoff(many, { limit: 5, chars: 120 });
  ok(hfSmall.rowChars <= 120 && hfSmall.turns < 5, `预算不够时从最旧丢轮（剩 ${hfSmall.turns} 轮 / ${hfSmall.rowChars} ≤ 120 字）`);
  ok(hfSmall.text.includes('第7轮') && !hfSmall.text.includes('第3轮'), '留下的是**最新**那几轮');
  ok(formatHandoff(many, { limit: HANDOFF_TURNS }).turns <= HANDOFF_TURNS, `默认最多 ${HANDOFF_TURNS} 轮`);

  console.log('== 3e. 跨会话交接：写盘与注入 ==');
  // `cli handoff --write` 写过之后，本仓库就有 pages/handoff.md ⇒ 开场注入该带上它
  const hoPath = path.join(real, 'pages', 'handoff.md');
  if (fs.existsSync(hoPath)) {
    const hoText = fs.readFileSync(hoPath, 'utf8');
    ok(/^# handoff（上次会话最后几轮/.test(hoText), 'handoff.md 是滚动覆盖的单份快照（`tick` 每次覆写）');
    ok((hoText.match(/^- 你：/gm) || []).length <= HANDOFF_TURNS, `写盘的轮次不超过 ${HANDOFF_TURNS} 轮`);
    const bt = bootstrapText(real, { budget: 8000 });
    ok(bt.includes('【上次聊到哪·最后几轮】'), '开场注入里出现了「上次聊到哪」段');
    const hoSeg = (bt.split('【上次聊到哪')[1] || '').split('\n【')[0];
    ok(hoSeg.length <= HANDOFF_CHARS, `该段不超预算（${hoSeg.length} ≤ ${HANDOFF_CHARS}；口径＝渲染出来的那一段）`);
    ok(bt.length <= 8000, `注入总量仍在上限内（${bt.length} ≤ 8000）`);
    ok(!/reasoning/i.test(hoSeg), '交接段里没有 reasoning 痕迹');
    // ⚠️ 这条是被 `cli dream` 当场抓出来的真 bug：`cli init` 会把 pages/ 下所有 .md 都
    //    reindexPage 一遍，于是 handoff.md 进了 index.json，做梦立刻把它当"知识条目"报出来
    //    （`handoff.md#0` 与 inbox 候选撞出 88% 重叠）。⇒ 判据：**元页从索引那一步就不入池**
    //    （index.mjs 的 guard）；`search()` 里那份 META_PAGES 过滤只管"显式问别名表时放行"。
    const idxDocs = JSON.parse(fs.readFileSync(path.join(real, 'index.json'), 'utf8')).docs || [];
    ok(!idxDocs.some((d) => d.page === 'handoff.md'), 'handoff.md **不在索引里**（滚动快照不得冒充知识参与召回/做梦）');
    // ⚠️ 上面那条量的是**真实 handoff.md**：内容短就绿 ⇒ 它只在"上一会话话多"时才红（2026-10-10 实测那次
    //    整段 633 > 620，而生成侧只保证**轮次正文** ≤ HANDOFF_CHARS）。改成下面这条**构造数据**的确定性断言：
    //    轮次正文顶满预算时，渲染出来的整段（含段标题与 `→ 详情` 行、含真实路径壳长）也不许超。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ho-'));
    fs.mkdirSync(path.join(tmp, 'pages'), { recursive: true });
    const fat = formatHandoff(Array.from({ length: HANDOFF_TURNS }, (_, i) => ({
      user: `第${i}轮：${'问'.repeat(100)}`, mine: '答'.repeat(90), at: i + 1,
    })), { limit: HANDOFF_TURNS });
    fs.writeFileSync(path.join(tmp, 'pages', 'handoff.md'), fat.text, 'utf8');
    const bt2 = bootstrapText(tmp, { budget: 8000 });
    const seg2 = (bt2.split('【上次聊到哪')[1] || '').split('\n【')[0];
    ok(seg2.length + '【上次聊到哪'.length <= HANDOFF_CHARS,
      `正文顶满预算时整段仍不超（${seg2.length + 7} ≤ ${HANDOFF_CHARS}；构造 ${fat.turns} 轮 / 正文 ${fat.rowChars} 字）`);
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    ok(true, 'handoff.md 还没生成（跑 `cli handoff --write` 后本节强断言才执行）');
  }

  console.log('== 3f. 选「上一个会话」要能跳过空会话（2026-09-29 修复） ==');
  // ⚠️ 回归守护：会话目录里会插进**空会话** —— 实测 `session-e56db903`：389 字节 / 5 条记录
  //    （session + permission/preset + sandbox/mode + approval/policy + session/end-seed）、
  //    **0 条用户消息**（开完没用过）。原实现固定取「倒数第二个」，碰上它就直接报
  //    「上一会话没抓到可交接的轮次」而**不往前找** ⇒ 开场注入的「上次聊到哪」一直停在更旧的一场
  //    （`tick` 打印的『交接：跳过』就是它）。现在逐个往前找；这条断言保证真插了空会话时仍找得到。
  const wh = writeHandoff(real, { write: false });
  ok(wh.ok === true, '能从倒数第 N 个会话里找到可交接的轮次（跳过中间的空会话）', wh.reason || '');
  ok(wh.turns > 0, `抓到 ${wh.turns} 轮交接（源 ${wh.label || '?'}）`);
  // 第 3g 节「空泛小结降级」已按域拆到 test-handoff-thin.mjs（2026-11-08，行数红线 120）
}
