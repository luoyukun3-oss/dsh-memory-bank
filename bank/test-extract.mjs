// ============================================================================
// test-extract.mjs —— LLM 抽取通道（2026-11-09）
//
// 守的是什么：这条通道会**花钱**、会**读主人的 key**、会把东西写进 inbox。
//   所以三件事必须有断言：① 没配置时静默跳过（不许抛、不许写）② 模型返回垃圾时不崩
//   ③ 成本护栏与既有判据真的生效（条数上限 / 超时 / scoreCandidate 门 / 去重）。
//
// ⚠️ 全部用**注入的假 fetch**：这里一次真实模型调用都不发。
//   真实链路另有人工验证（见本轮报告「实际调用次数」）。
// ⚠️ 造数据用临时目录，不碰真库。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LIMITS, appendToInbox, buildExtractPrompt, extractCandidates,
  parseExtractResponse, renderInboxLines,
} from './extract.mjs';
import { loadLlmConfig, parseProviderConfig } from './extract-config.mjs';   // 2026-11-09 按域拆出（extract.mjs 超预算）
import { runCursorTests } from './test-extract-cursor.mjs';                   // §8~14 游标 + 分批（独立文件，主文件才守得住 200 行）

let pass = 0;
const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) { pass += 1; console.log('  [OK] ' + msg + (extra ? '（' + extra + '）' : '')); return; }
  fails.push(msg + (extra ? '（' + extra + '）' : ''));
  console.log('  [FAIL] ' + msg + (extra ? '（' + extra + '）' : ''));
};

/** 最小银行：extract 只碰 pages/inbox.md、discarded.json、state/ */
function makeBank() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-extract-'));
  const repo = path.join(tmp, 'repo');
  for (const d of ['pages', 'state']) fs.mkdirSync(path.join(repo, d), { recursive: true });
  fs.writeFileSync(path.join(repo, 'pages', 'inbox.md'), '# inbox（自动记录的待整理素材）\n');
  fs.writeFileSync(path.join(repo, 'discarded.json'), JSON.stringify({ items: [] }));
  return { tmp, repo };
}

const GOOD_CFG = { ok: true, apiKey: 'test-key-not-real', baseUrl: 'https://example.invalid/v1', model: 'test-model' };

/** 假 fetch：记录调用，按需返回状态码 / JSON / 抛错 */
function fakeFetch({ status = 200, body = null, throwName = null, calls = [] } = {}) {
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (throwName) { const e = new Error(throwName === 'TimeoutError' ? 'The operation was aborted due to timeout' : 'boom'); e.name = throwName; throw e; }
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fn, calls };
}

const reply = (content) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 34 } });

console.log('== 1. parseProviderConfig：只认目标 provider 的 baseURL（多 provider 时不抓错） ==');
const YAML = [
  '      other:',
  '        apiKeyEnv: OTHER_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://other.example/v1',
  '      shengyan:',
  '        displayName: shengyan',
  '        apiKeyEnv: SHENGYAN_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://api.example.test/v1',
  '        models:',
  '          - id: Model-A',
  '            name: Model-A',
  '          - id: Model-B',
].join('\n');
const pc = parseProviderConfig(YAML);
ok(pc.keyEnv === 'SHENGYAN_API_KEY', '定位到 shengyan 那一家', pc.keyEnv);
ok(pc.baseUrl === 'https://api.example.test/v1', 'baseURL 不串到别家（other.example 被跳过）', pc.baseUrl);
ok(pc.model === 'Model-A', '取该 provider 的第一个 model id', pc.model);
const pcNoPref = parseProviderConfig(YAML, { preferKeyEnv: 'NOPE_KEY' });
ok(pcNoPref.baseUrl === 'https://other.example/v1', '优先 key 找不到时退回第一个 apiKeyEnv', pcNoPref.baseUrl);

console.log('== 2. loadLlmConfig：没 key / 有 key 两条路，且只报位置不泄值 ==');
const b2 = makeBank();
const credOk = path.join(b2.tmp, 'cred-ok.yaml');
const credNo = path.join(b2.tmp, 'cred-no.yaml');
const patch = path.join(b2.tmp, 'patch.yml');
fs.writeFileSync(credOk, 'refs:\n  SHENGYAN_API_KEY: sk-test-123456\n  OTHER_API_KEY: zzz\n');
fs.writeFileSync(credNo, 'refs:\n  OTHER_API_KEY: zzz\n');
fs.writeFileSync(patch, YAML);
const c1 = loadLlmConfig({ env: {}, files: { credentials: credOk, patch } });
ok(c1.ok === true, 'credentials 里有 key ⇒ ok', c1.reason || 'ok');
ok(c1.keyFrom === 'cred-ok.yaml:refs.SHENGYAN_API_KEY', 'key 来源记到位置（不打印值）', c1.keyFrom);
ok(c1.baseUrl === 'https://api.example.test/v1' && c1.model === 'Model-A', 'baseUrl/model 来自 patch');
const c2 = loadLlmConfig({ env: {}, files: { credentials: credNo, patch } });
ok(c2.ok === false && /no-api-key/.test(c2.reason), '没 key ⇒ ok:false + no-api-key 原因', c2.reason);
const c3 = loadLlmConfig({ env: { SHENGYAN_API_KEY: 'sk-env', SHENGYAN_BASE_URL: 'https://env.test/v1', EXTRACT_MODEL: 'env-model' }, files: { credentials: credNo, patch } });
ok(c3.ok && c3.keyFrom === 'env.SHENGYAN_API_KEY' && c3.model === 'env-model', '环境变量优先于文件');

console.log('== 3. buildExtractPrompt：成本护栏（条数 + 总长） ==');
const many = Array.from({ length: 31 }, (_, i) => '第' + i + '条消息内容');
const p1 = buildExtractPrompt(many, { maxMessages: LIMITS.maxMessages });
ok(p1.used === LIMITS.maxMessages, '最多只喂 ' + LIMITS.maxMessages + ' 条', 'used=' + p1.used);
ok(p1.dropped === 1, '多出来的记账为 dropped=1', 'dropped=' + p1.dropped);
ok(p1.user.includes('第0条') && !p1.user.includes('第30条'), '★ 取的是**最早**的 30 条（2026-11-09 改：不再取"最近"，长会话前半不再漏）');
const huge = Array.from({ length: 30 }, () => 'x'.repeat(300));
const p2 = buildExtractPrompt(huge);
ok(p2.used < 30 && p2.user.length <= LIMITS.maxPromptChars + 400, '总长超限时继续从最早一端丢', 'used=' + p2.used + ' len=' + p2.user.length);
ok(buildExtractPrompt([]).used === 0, '空输入 ⇒ used=0（调用方据此不发请求）');

console.log('== 4. parseExtractResponse：正常 / 围栏 / 垃圾 三种输入 ==');
const good = parseExtractResponse('[{"kind":"preferences","text":"喜欢先看代码","why":"偏好"}]');
ok(good.ok && good.candidates.length === 1 && good.candidates[0].kind === 'preferences', '正常 JSON 数组解析成功');
const fenced = parseExtractResponse('```json\n[{"kind":"lessons","text":"CUDA DLL 要先查 PATH","why":"踩坑"}]\n```');
ok(fenced.ok && fenced.candidates.length === 1, '剥掉 ```json 围栏后仍能解析');
const junk = parseExtractResponse('我觉得这些都挺重要的，你自己看吧');
ok(junk.ok === false && junk.candidates.length === 0, '★ 垃圾/非 JSON ⇒ ok:false 且**不抛**', junk.reason);
const junk2 = parseExtractResponse('');
ok(junk2.ok === false, '空响应 ⇒ ok:false');
const mixed = parseExtractResponse('[{"kind":"hack","text":"非法类型"},{"kind":"lessons"},{"kind":"todos","text":"回头把 A 改了"},null]');
ok(mixed.ok && mixed.candidates.length === 1 && mixed.candidates[0].kind === 'todos', '非法 kind / 缺字段的元素被过滤', 'kept=' + mixed.candidates.length);
ok(mixed.dropped === 3, '被过滤的条数记进 dropped', 'dropped=' + mixed.dropped);
const caps = parseExtractResponse(JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ kind: 'todos', text: '待办' + i }))), { maxCandidates: 10 });
ok(caps.candidates.length === 10, '候选条数上限 ' + LIMITS.maxCandidates, 'kept=' + caps.candidates.length);

console.log('== 5. extractCandidates：没配置 / 正常 / 超时 / HTTP 错 / 垃圾输出 ==');
const noCfg = await extractCandidates(b2.repo, { config: { ok: false, reason: 'no-api-key' }, texts: ['x'] });
ok(noCfg.ok === false && noCfg.calls === 0, '没配置 ⇒ 直接返回，**一次请求都不发**', 'calls=' + noCfg.calls);
const f1 = fakeFetch({ body: reply('[{"kind":"preferences","text":"主人喜欢先看代码再动手","why":"明确偏好"}]') });
const r1 = await extractCandidates(b2.repo, { config: GOOD_CFG, texts: ['记住我喜欢先看代码'], fetchImpl: f1.fn });
ok(r1.ok && r1.candidates.length === 1 && r1.calls === 1, '正常一轮：解析出 1 条候选', 'calls=' + r1.calls);
ok(String(f1.calls[0].url).endsWith('/chat/completions'), '打到 OpenAI 兼容的 /chat/completions', f1.calls[0].url);
ok(f1.calls[0].init.signal && typeof f1.calls[0].init.signal.aborted === 'boolean', '★ 请求带硬超时 signal');
const sentBody = JSON.parse(f1.calls[0].init.body);
ok(sentBody.max_tokens === LIMITS.maxOutTokens, '输出限长 max_tokens=' + LIMITS.maxOutTokens, String(sentBody.max_tokens));
ok(!JSON.stringify(f1.calls[0].init.headers).includes('sk-'), '请求头里没有把 key 写进明文日志的迹象（只有 Bearer 头）');
const f2 = fakeFetch({ throwName: 'TimeoutError' });
const r2 = await extractCandidates(b2.repo, { config: GOOD_CFG, texts: ['x'], fetchImpl: f2.fn, timeoutMs: 20 });
ok(r2.ok === false && /timeout/.test(r2.reason), '★ 超时 ⇒ ok:false + timeout，不抛', r2.reason);
const f3 = fakeFetch({ status: 500, body: { error: 'boom' } });
const r3 = await extractCandidates(b2.repo, { config: GOOD_CFG, texts: ['x'], fetchImpl: f3.fn });
ok(r3.ok === false && /http 500/.test(r3.reason), 'HTTP 500 ⇒ ok:false 不抛', r3.reason);
const f4 = fakeFetch({ body: reply('我不想输出 JSON，你猜') });
const r4 = await extractCandidates(b2.repo, { config: GOOD_CFG, texts: ['x'], fetchImpl: f4.fn });
ok(r4.ok === false && r4.candidates.length === 0, '★ 模型返回垃圾 ⇒ ok:false，不崩', r4.reason);
const f5 = fakeFetch({ body: { choices: [] } });
const r5 = await extractCandidates(b2.repo, { config: GOOD_CFG, texts: ['x'], fetchImpl: f5.fn });
ok(r5.ok === false, 'choices 为空 ⇒ ok:false', r5.reason);

console.log('== 6. appendToInbox：过 scoreCandidate 门 + 三方去重 + 格式 ==');
const b6 = makeBank();
const cands = [
  { kind: 'preferences', text: '主人喜欢先看代码再动手', why: '偏好' },
  { kind: 'todos', text: '现在待办还有什么要做吗？', why: '模型以为这是待办' },
];
const a1 = appendToInbox(b6.repo, cands, { date: '2026-11-09' });
ok(a1.kept.length === 1, '★ 提问被 scoreCandidate 门挡下（复用现有判据）', 'kept=' + a1.kept.length + ' gate=' + a1.skippedGate);
ok(a1.skippedGate === 1, '挡下的条数有记账', String(a1.skippedGate));
const inboxText = fs.readFileSync(path.join(b6.repo, 'pages', 'inbox.md'), 'utf8');
ok(inboxText.includes('- 2026-11-09 [preferences·LLM] 主人喜欢先看代码再动手'), '★ 写入格式沿用现有格式并标出 ·LLM 来源');
ok(!inboxText.includes('待办还有什么要做吗'), '被门挡下的内容**没**写进文件');
const a2 = appendToInbox(b6.repo, [{ kind: 'preferences', text: '主人喜欢先看代码再动手' }], { date: '2026-11-09' });
ok(a2.kept.length === 0 && a2.skippedDup === 1, '同一条再来一次 ⇒ 重复跳过', 'dup=' + a2.skippedDup);
fs.writeFileSync(path.join(b6.repo, 'discarded.json'), JSON.stringify({ items: ['2026-11-08 [todos] 回头把待办面板重做一遍'] }));
const a3 = appendToInbox(b6.repo, [{ kind: 'todos', text: '回头把待办面板重做一遍' }], { date: '2026-11-09' });
ok(a3.kept.length === 0 && a3.skippedDup === 1, 'discarded.json 里丢过的 ⇒ 不再抓（与 ingest 同一口径）', 'dup=' + a3.skippedDup);
ok(renderInboxLines([{ kind: 'lessons', text: 'CUDA DLL 先查 PATH' }], { date: '2026-11-09' })[0] === '- 2026-11-09 [lessons·LLM] CUDA DLL 先查 PATH', 'renderInboxLines 单行格式');

console.log('== 7. 不许直接写知识页（边界断言） ==');
const b7 = makeBank();
const a7 = appendToInbox(b7.repo, [{ kind: 'lessons', text: '这是不该写进 lessons 页的候选' }], { date: '2026-11-09' });
ok(a7.kept.length === 1, '候选照常收下');
ok(!fs.existsSync(path.join(b7.repo, 'pages', 'lessons.md')), '★ 只创建/追加 inbox.md，**没有生成 lessons.md**');
ok(fs.readdirSync(path.join(b7.repo, 'pages')).every((f) => f.endsWith('.bak-') || f === 'inbox.md'), 'pages 下除了 inbox 没有别的新文件', fs.readdirSync(path.join(b7.repo, 'pages')).join(','));

// §8~14：游标 + 分批（拆到 test-extract-cursor.mjs；`ok` 传进去，计数与 exit 仍在本文件一处汇总）
await runCursorTests({ ok });

console.log('');
if (fails.length) {
  console.log('结果：' + pass + ' 通过 / ' + fails.length + ' 失败');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('结果：' + pass + ' 通过 / 0 失败');
