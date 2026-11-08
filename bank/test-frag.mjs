// 碎片复读判据的测试（2026-10-08 新增，随 frag-detect.mjs 一起）。
// 做法与 test-slope.mjs 同源：核心断言是**对照组检验**（正样本 vs 负样本）——
// 因为这条判据的两个单项各自都会虚警（单看 repeat≥10 在全库命中 457 步；单看碎片比 90 分位分不开），
// **只有两者同时**才是干净分界。测试要把这条判别力钉住，否则将来谁放宽阈值就会静默退化。
import { fragmentOf, isFragmentHit, auditFragment, SELF_ORDER } from './frag-detect.mjs';
import { REPEAT_MIN } from './slope-detect.mjs';
import { FRAG_MIN_CHARS, FRAG_RATIO_MIN, SELF_REPEAT_MIN } from './config-keys.mjs';

export function runFragTests({ ok }) {
  console.log('== 21. 碎片复读判据（二型：同句≥10 且 碎片比≥0.20；三型：自促词≥10，均要求思考≥400 字） ==');

  // --- 正样本：2026-10-08 上个会话（8cb103d2）t314 的真实形态：短句「写」复读 93 次、碎片比 0.28 ---
  const bad = Array.from({ length: 60 }, () => '写。⇒ 写 ✓ 好 ✓ 写。').join(' ');
  const mBad = fragmentOf(bad);
  ok(mBad.chars >= FRAG_MIN_CHARS, `正样本：思考 ${mBad.chars} 字（≥${FRAG_MIN_CHARS}）`);
  ok(mBad.repeat >= REPEAT_MIN, `正样本：同一短句重复 ${mBad.repeat} 次（≥${REPEAT_MIN}）`, `top=${mBad.top}`);
  ok(mBad.fragRatio >= FRAG_RATIO_MIN, `正样本：碎片比 ${mBad.fragRatio.toFixed(2)}（≥${FRAG_RATIO_MIN}）`);
  ok(isFragmentHit(mBad) === true, '正样本判定为「碎片复读」');

  // --- 负样本 1：技术词机械重复（正常排查，词表必须挡住）---
  const tech = Array.from({ length: 60 }, () => 'python。pwsh。ctx。').join(' ');
  ok(fragmentOf(tech).repeat === 0 && isFragmentHit(fragmentOf(tech)) === false,
    '负样本 1：技术词重复不算复读（TECH 表挡住了）');

  // --- 负样本 2：**碎片很多但不重复**（各家一句）⇒ 只看碎片比会误报，必须挡住 ---
  const fragNoRep = Array.from({ length: 40 }, (_, i) => `第${i}件`).join('。') + '。';
  const m2 = fragmentOf(fragNoRep);
  ok(m2.fragRatio >= FRAG_RATIO_MIN && m2.repeat < REPEAT_MIN && isFragmentHit(m2) === false,
    '负样本 2：只有碎片、没有重复 ⇒ 不命中', `frag=${m2.fragRatio.toFixed(2)} repeat=${m2.repeat}`);

  // --- 负样本 3：**长句重复**（>12 字不计入"复读短句"）⇒ 只看 repeat 也不该命中 ---
  const repNoFrag = Array.from({ length: 20 }, () => '把这份速查表的目录补上一句话含义然后再核对示例数量').join('。') + '。';
  const m3 = fragmentOf(repNoFrag);
  ok(m3.repeat === 0 && m3.fragRatio < FRAG_RATIO_MIN && isFragmentHit(m3) === false,
    '负样本 3：长句重复不算碎片复读', `repeat=${m3.repeat} frag=${m3.fragRatio.toFixed(2)}`);

  // --- 负样本 4：正常的连贯长推演（真实会话里最常见的样子）---
  const good = '先把 bootstrap.mjs 的 SEG_BUDGET 读出来，确认「上次聊到哪」那一段加了六百字之后总配额仍然是七千四。'
    + '然后跑一次 cli preview，看渲染结果里 handoff 段的长度有没有超过 HANDOFF_CHARS 这个常量。'
    + '如果没有超过，就把这次标定的结论写进 procedures 页，顺便核对 config-keys 的消费点登记有没有漏。';
  ok(isFragmentHit(fragmentOf(good)) === false, '负样本 4：正常连贯推演不判复读',
    `repeat=${fragmentOf(good).repeat} frag=${fragmentOf(good).fragRatio.toFixed(2)}`);

  // --- 正样本 5（坡面三型，2026-11-02）：形如 turn 41 step 16 的真实形态 ——
  //     「做。」×12 夹在大段分析中间 ⇒ fragRatio 只有约 0.04，二型必漏，三型必须抓住。
  const details = Array.from({ length: 30 }, (_, i) => `第${i}段文字要逐行核对`);
  const longTail = '这里再补一段完整分析，说明为什么先读源码再动手，以及改完要怎么验证才算数。';
  const selfCase = Array.from({ length: 12 }, () => '做').join('。') + '。' + details.join('。') + '。' + longTail.repeat(4);
  const m5 = fragmentOf(selfCase);
  ok(m5.chars >= FRAG_MIN_CHARS, `正样本 5：思考 ${m5.chars} 字（≥${FRAG_MIN_CHARS}）`);
  ok(m5.top === '做' && m5.repeat >= SELF_REPEAT_MIN, `正样本 5：自促词「做」×${m5.repeat}（≥${SELF_REPEAT_MIN}）`);
  ok(m5.fragRatio < FRAG_RATIO_MIN, `正样本 5：碎片比只有 ${m5.fragRatio.toFixed(3)}（<${FRAG_RATIO_MIN}，二型必漏）`);
  ok(isFragmentHit(m5) === true, '正样本 5：三型判据命中（不看碎片比）');

  // --- 负样本 5：非自促词高重复（2026-11-02 全库噪声榜首是 `</p`×36）⇒ 词表外，必须挡住 ---
  const noiseCase = Array.from({ length: 12 }, () => '</p').join('。') + '。' + details.join('。') + '。' + longTail.repeat(4);
  const m6 = fragmentOf(noiseCase);
  ok(m6.repeat >= SELF_REPEAT_MIN && !SELF_ORDER.has(m6.top), `负样本 5：\`${m6.top}\`×${m6.repeat} 重复够多但不在自促词表`);
  ok(m6.fragRatio < FRAG_RATIO_MIN && isFragmentHit(m6) === false, '负样本 5：非自促词 + 低碎片比 ⇒ 不命中');

  // --- 负样本 6：自促词但只重复 5 次（正常口癖）⇒ 阈值必须挡住 ---
  const fewCase = Array.from({ length: 5 }, () => '好').join('。') + '。' + details.join('。') + '。' + longTail.repeat(4);
  const m7 = fragmentOf(fewCase);
  ok(m7.top === '好' && m7.repeat < SELF_REPEAT_MIN && isFragmentHit(m7) === false,
    `负样本 6：自促词「好」×${m7.repeat}（<${SELF_REPEAT_MIN}）⇒ 不判复读`);

  // --- 端到端：auditFragment 必须跳过流中断（思考被硬切断不是复读，处方相反）---
  const rec = (turn, extra) => ({
    type: 'assistant/message', time: 't',
    data: { turn, step: 1, usage: { inputTokens: 1000, cacheReadTokens: 0 }, message: { content: [{ type: 'reasoning', text: bad }] }, ...extra },
  });
  const r = auditFragment([rec(1, {}), rec(2, { interrupted: true }), { type: 'user/message', data: {} }]);
  ok(r.count === 1, '端到端：只有 1 步命中，interrupted 那步被跳过', `count=${r.count}`);
  ok(r.first && r.first.turn === 1 && r.first.repeat >= REPEAT_MIN, '端到端：first 指向第一处命中并带上 turn/repeat');
}
