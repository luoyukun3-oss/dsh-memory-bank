// 复读斜坡判据的测试（2026-09-22 新增，随 slope-detect.mjs 一起）。
// 为什么单独一节而不是塞进 test.mjs：test.mjs 当时 323/350（92%），按 budgets.json 的规矩
// 「超限先按域拆分」；且这一节守的是「2026-09-22 新机制」，与主文件的通用断言不同域（先例：test-mechanisms / test-handoff）。
//
// ⚠️ 这一节的**核心断言是对照组检验**（正样本 vs 负样本），因为本判据的两次前身都栽在
//    「单信号虚警」上：短句重复 ≥10 在正常会话也 fire 15 条、元指令 ≥2 也 fire 4 条，
//    **只有两者同时**才是 49:0 的干净分界。测试必须把这条判别力钉住，否则将来有人放宽阈值就会静默退化。
import { readRecords, findTranscripts } from './core.mjs';
import { slopeOf, auditSlope, REPEAT_MIN, META_MIN } from './slope-detect.mjs';

export function runSlopeTests({ ok }) {
  console.log('== 20. 复读斜坡判据（双信号：同一短句≥10 **且** 出现「对思考本身的指令」） ==');

  // --- 正样本：09-18 那场真实日志里的一步（实测重复「好」×62） ---
  const bad = '**好。** **Go.** 好。 **（输出。）** 好。 （执行。） 好。 **（写工具调用。）** 好。 '
    + '**（我立即输出。）** 好。 **（我停止循环，输出工具调用。）** 好。 写。 好。 **Go.** 好。 （输出。）'
    + '好。 好。 好。 好。 好。 好。 好。 好。 好。 好。';
  const sBad = slopeOf(bad);
  ok(sBad.repeat >= REPEAT_MIN, `正样本：同一短句重复 ${sBad.repeat} 次（≥${REPEAT_MIN}）`, `top=${sBad.top}`);
  ok(sBad.meta >= META_MIN, `正样本：元指令 ${sBad.meta} 次（≥${META_MIN}）`);
  ok(sBad.hit === true, '正样本判定为「进入复读」');

  // --- 负样本 1：正常过渡（一次性的「好，执行。」+ 有实质内容）---
  const good1 = '先把 `bootstrap.mjs` 的 SEG_BUDGET 读出来，确认「上次聊到哪」段加了 600 字之后总配额还是 7400。'
    + '然后跑 cli preview 看渲染结果对不对。好，执行。pwsh 跑一行命令即可。';
  ok(slopeOf(good1).hit === false, '负样本 1：正常推演（一次性过渡）不判复读',
    `repeat=${slopeOf(good1).repeat} meta=${slopeOf(good1).meta}`);

  // --- 负样本 2：**只有重复、没有元指令**（实测正常会话 `0a615b67` 就是这么被误伤的）---
  const good2 = Array.from({ length: 15 }, () => '好').join('。') + '。';
  const s2 = slopeOf(good2);
  ok(s2.repeat >= REPEAT_MIN && s2.meta === 0 && s2.hit === false,
    '负样本 2：**光重复不命中**（这是单信号虚警 15:99 的来源，必须挡住）');

  // --- 负样本 3：**只有元指令、没有重复**（实测正常会话 `f2ada28e` 的 meta×4 就是这样）---
  //   ⚠️ 样本本身要真含 ≥2 个元指令（首版只写了 1 个可被正则命中的形态 ⇒ 断言红了，
  //   是**测试样本写错**而不是判据错 —— 与 test-handoff 里那条同族教训）。
  const good3 = '我先确认它是否真的生效。（输出。）跑一次看看。（执行。）再核对一行。（写工具调用。）'
    + '再把结论写进知识页，顺便核对一下行数预算有没有超。';
  const s3 = slopeOf(good3);
  ok(s3.meta >= META_MIN && s3.repeat < REPEAT_MIN && s3.hit === false,
    '负样本 3：**光有元指令也不命中**（单信号虚警 4:49 的来源）', `repeat=${s3.repeat} meta=${s3.meta}`);

  // --- 负样本 4：**技术词机械重复不算**（实测 `#51 t8/1`（ctx 117k）重复「python」×11 是正常排查）---
  const tech = Array.from({ length: 12 }, () => 'python').join('。') + '。（输出。）我立即输出。';
  const s4 = slopeOf(tech);
  ok(s4.hit === false, '负样本 4：技术词（python）机械重复不算复读', `top=${s4.top} repeat=${s4.repeat} meta=${s4.meta}`);

  // --- 整会话回放：那场会话应命中 66 条、拐点 ctx≈411k（实测基线，改阈值会红）---
  const t = findTranscripts('E:\\2').find((f) => f.dirName.includes('7343d6e6') && f.file.includes('session.v3'));
  if (t) {
    const r = auditSlope(readRecords(t.file));
    ok(r.count === 66, `真实回放：那场会话命中 ${r.count} 条（实测基线 66）`);
    ok(r.first && r.first.turn >= 20, `双信号首次命中在 t${r.first?.turn}/${r.first?.step}（ctx≈${Math.round((r.first?.ctxTokens || 0) / 1000)}k）`);
    // 拐点：比双信号更早、比坡底早得多 —— 这是本轮最值钱的那个数
    ok(r.knee && r.knee.ctxTokens > 380e3 && r.knee.ctxTokens < 440e3,
      `拐点落在 ctx≈${Math.round((r.knee?.ctxTokens || 0) / 1000)}k（实测 411k；判据=复读率首次≥30% 且此后不回落）`);
    const vis = r.hits.filter((h) => h.hasVisible).length;
    ok(vis > 40, `其中 ${vis} 条**照样有正文或工具调用**（旧判据完全看不见 ⇒ 这就是加这条判据的理由）`);
    ok(r.hits.every((h) => h.repeat >= REPEAT_MIN && h.meta >= META_MIN), '每一条都满足双信号（判据没被写错）');
  } else {
    ok(true, '找不到那场会话日志，跳过真实回放断言');
  }
}
