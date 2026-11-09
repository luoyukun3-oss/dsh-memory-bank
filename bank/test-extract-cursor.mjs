// ============================================================================
// test-extract-cursor.mjs —— extract 的「游标 + 分批」（2026-11-09）
//
// 守的是什么：老实现 `buildExtractPrompt` 里是 `list.slice(-30)` —— **只取最近 30 条**，
//   一个 83 条消息的会话，前 53 条永远提取不到（窗口滑过就漏）。
//   现在改成「读游标之后的全部消息 → 按批跑 → 每批成功才推进游标」。这里守五件事：
//     ① 50 条消息一条不漏（旧行为只提 30 条）
//     ② 字数上限（不只是条数）也会触发分批
//     ③ 中途失败 ⇒ 游标停在**最后成功的那一批**，下次从这里继续
//     ④ 幂等：游标到末尾后再跑，一次请求都不发
//     ⑤ 两条安全边界：没 key 时游标不动；**预演（noAdvance）不推进游标**
//        （否则候选没落库、消息却被记成"已提取" ⇒ 那批永久漏掉）
//
// ⚠️ 全部用**注入的假 fetch**：一次真实模型调用都不发；造数据全在临时目录。
// 从 test-extract.mjs 拆出（2026-11-09）：那边 251/200 超预算，按项目原则「先按域拆，别压缩行宽」。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cursorPath, extractCandidates, planBatches, readCursor } from './extract.mjs';

const GOOD_CFG = { ok: true, apiKey: 'test-key-not-real', baseUrl: 'https://example.invalid/v1', model: 'test-model' };

/** 最小银行：extract 只碰 state/（游标）与 pages/ */
function makeBank() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cur-'));
  const repo = path.join(tmp, 'repo');
  for (const d of ['pages', 'state']) fs.mkdirSync(path.join(repo, d), { recursive: true });
  fs.writeFileSync(path.join(repo, 'pages', 'inbox.md'), '# inbox\n');
  fs.writeFileSync(path.join(repo, 'discarded.json'), JSON.stringify({ items: [] }));
  return { tmp, repo };
}

/** `ok` 由主文件传入（同 test-mechanisms 的做法）：计数与 exit 只在一处 */
export async function runCursorTests({ ok }) {
  const T50 = Array.from({ length: 50 }, (_, i) => '第' + (i + 1) + '条消息内容');
  const okResp = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[]' } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }) };

  console.log('== 8. 游标 + 分批：50 条消息一条不漏（旧行为只提最近 30 条） ==');
  const b8 = makeBank();
  const sent8 = [];
  const r8 = await extractCandidates(b8.repo, {
    config: GOOD_CFG, texts: T50, sessionKey: 'sess-50',
    fetchImpl: async (u, init) => { sent8.push(JSON.parse(init.body).messages[1].content); return okResp; },
  });
  const allSent8 = sent8.join('\n');
  const missing8 = T50.filter((t) => !allSent8.includes(t));
  ok(missing8.length === 0, '★ 50 条消息**全部**进入过 prompt（一条不漏）', missing8.length ? '漏 ' + missing8.length + ' 条：' + missing8.slice(0, 3).join(' | ') : '50/50');
  ok(r8.batches === 2 && r8.calls === 2, '单批上限 30 条 ⇒ 切成 2 批', 'batches=' + r8.batches);
  ok(r8.advanced === 50, '游标一次推进 50 条', 'advanced=' + r8.advanced);
  ok(readCursor(b8.repo)['sess-50'] === 50, '★ 游标文件里记到 50', JSON.stringify(readCursor(b8.repo)));

  console.log('== 9. 字数上限也会触发分批（不是只有条数） ==');
  const b9 = makeBank();
  const longTexts = Array.from({ length: 20 }, (_, i) => '第' + (i + 1) + '条' + 'x'.repeat(200));
  const sent9 = [];
  const r9 = await extractCandidates(b9.repo, {
    config: GOOD_CFG, texts: longTexts, sessionKey: 'sess-long', maxPromptChars: 1200,
    fetchImpl: async (u, init) => { sent9.push(JSON.parse(init.body).messages[1].content); return okResp; },
  });
  ok(r9.batches > 1, '★ 每条 ~200 字 + 上限 1200 ⇒ 切成多批', 'batches=' + r9.batches);
  ok(sent9.every((t) => t.length <= 1200 + 400), '每批都没超字数上限（留 400 余量给编号换行）', 'max=' + Math.max(...sent9.map((t) => t.length)));
  ok(readCursor(b9.repo)['sess-long'] === 20, '游标推进到 20（全部处理完）');

  console.log('== 10. 中途失败 ⇒ 游标停在最后成功的批 ==');
  const b10 = makeBank();
  let n10 = 0;
  const r10 = await extractCandidates(b10.repo, {
    config: GOOD_CFG, texts: T50, sessionKey: 'sess-fail',
    fetchImpl: async () => { n10 += 1; if (n10 === 2) throw new Error('boom-2nd-batch'); return okResp; },
  });
  ok(r10.batches === 1, '第 2 批抛错 ⇒ 只成功了 1 批', 'batches=' + r10.batches);
  ok(r10.ok === true && /boom-2nd-batch/.test(String(r10.stopped)), '★ 部分成功仍 ok:true，并带 stopped 原因', r10.stopped);
  ok(readCursor(b10.repo)['sess-fail'] === 30, '★ 游标停在最后成功的批末尾（30）', 'cursor=' + readCursor(b10.repo)['sess-fail']);
  const sent10 = [];
  const r10b = await extractCandidates(b10.repo, {
    config: GOOD_CFG, texts: T50, sessionKey: 'sess-fail',
    fetchImpl: async (u, init) => { sent10.push(JSON.parse(init.body).messages[1].content); return okResp; },
  });
  ok(r10b.from === 30 && r10b.advanced === 20, '下次从第 31 条继续（只处理剩下 20 条）', 'from=' + r10b.from + ' advanced=' + r10b.advanced);
  const sent10All = sent10.join('\n');
  ok(!sent10All.includes('第1条消息内容') && sent10All.includes('第31条消息内容'), '★ 前 30 条没重复发送，从第 31 条接上');

  console.log('== 11. 幂等：游标到末尾后再跑，一次请求都不发 ==');
  const calls11 = [];
  const r11 = await extractCandidates(b10.repo, {
    config: GOOD_CFG, texts: T50, sessionKey: 'sess-fail',
    fetchImpl: async () => { calls11.push(1); return okResp; },
  });
  ok(calls11.length === 0 && r11.calls === 0, '★ 不发请求', 'calls=' + calls11.length);
  ok(r11.advanced === 0 && /游标已到末尾/.test(String(r11.note)), '如实说明「游标已到末尾」', r11.note);

  console.log('== 12. 没 key ⇒ 游标不动（连文件都不建） ==');
  const b12 = makeBank();
  const r12 = await extractCandidates(b12.repo, { config: { ok: false, reason: 'no-api-key' }, texts: T50, sessionKey: 'sess-nokey' });
  ok(r12.ok === false && r12.calls === 0, '没配置直接返回，不发请求');
  ok(!fs.existsSync(cursorPath(b12.repo)), '★ 游标文件都没被创建');
  ok(Object.keys(readCursor(b12.repo)).length === 0, '读回来是空表');

  console.log('== 13. planBatches 边界 ==');
  ok(planBatches([], 0).length === 0, '空输入 ⇒ 没有批');
  ok(planBatches(T50, 50).length === 0, '游标已到末尾 ⇒ 没有批');
  const pbMax = planBatches(T50, 0, { maxPerRun: 10 });
  ok(pbMax.length === 1 && pbMax[0].to === 10, '`--max 10` ⇒ 本次只切 10 条（人工闸门）', JSON.stringify(pbMax));
  const pbHuge = planBatches(['y'.repeat(300)], 0, { maxPromptChars: 10 });
  ok(pbHuge.length === 1 && pbHuge[0].to === 1, '★ 单条就超字数上限时也至少收 1 条（不死循环）', JSON.stringify(pbHuge));

  console.log('== 14. 预演（noAdvance）不推进游标 ==');
  const b14 = makeBank();
  const r14 = await extractCandidates(b14.repo, { config: GOOD_CFG, texts: T50, sessionKey: 'sess-dry', noAdvance: true, fetchImpl: async () => okResp });
  ok(r14.batches === 2 && r14.advanced === 50, '预演照样跑完 2 批（该花的钱照花，效果要能看）', 'batches=' + r14.batches);
  ok(Object.keys(readCursor(b14.repo)).length === 0, '★ 但游标仍然是空的 ⇒ 下次还会处理同一批，不漏', JSON.stringify(readCursor(b14.repo)));
}
