// ============================================================================
// Memory Bank · extract —— **LLM 抽取通道**（2026-11-09）
//
// 为什么加：现有提取是纯正则（ingest.mjs 的 HEUR 四组 + scoreCandidate 门），
//   关键词法分不出「陈述」与「提问/指令/任务书/汇报」—— 历史上五次清空 inbox，误抓率最高 74%
//
// 三条铁律（任何一条都不许破）：
//   ① **绝不直接写知识页** —— 产出只进 pages/inbox.md（未经验证、不进召回），
//      晋升仍靠人审。这是 ingest 沿用至今的安全边界，LLM 通道不许绕。
//   ② **没 key / 调不通 / 输出是垃圾 ⇒ 返回 { ok:false, reason } 静默跳过**，绝不抛错。
//      （tick/ingest 那条链路"记账模块不该拖垮主流程"，这里同理。）
//   ③ **成本护栏全在常量里**：消息条数 / 单条字数 / prompt 总长 / 输出 tokens / 硬超时 / 候选条数。
//
// 零依赖：只用 node 内置 fetch（Node 18+），**不引任何 SDK**。
// 配置来源（只读，不落盘、不打印 key）：
//   · key   ← $SHENGYAN_API_KEY 或 $DSH_HOME/.credentials.yaml 的 refs: 段
//   · base  ← $SHENGYAN_BASE_URL 或 profile 的 cordis.patch.yml 里 baseURL:
//   · model ← $EXTRACT_MODEL 或 patch 里该 provider 的第一个 - id:
//
// 🔪 2026-11-09 按域拆分（本文件当时 **350/360，97%**，逼近 budgets.json 红线）——四块各归其位：
//   · 成本护栏 + 系统提示词 + 分批  → extract-prompt.mjs
//   · 模型输出解析                  → extract-parse.mjs
//   · 游标 / inbox 写出 / 抽取记录  → extract-store.mjs
//   · 配置定位（更早一轮拆的）      → extract-config.mjs
//   本文件只留**编排**：读会话日志 → 逐批调模型 → 成功一批才推进游标，以及 CLI 外壳。
//   ⇒ 对外接口**一个没变**：所有旧导出在本文件继续 re-export，调用方零改动。
// ============================================================================
import { clip, findTranscripts, readRecords, textOf } from './core.mjs';
import { INBOX_GATE } from './ingest.mjs';                 // 复用现有判据，绝不另写一套
import { loadLlmConfig } from './extract-config.mjs';      // 配置定位（更早一轮按域拆出）
import { LIMITS, buildExtractPrompt, planBatches, str } from './extract-prompt.mjs';
import { parseExtractResponse } from './extract-parse.mjs';
import {
  appendToInbox, cursorKey, readCursor, saveCursor, saveExtractLog,
} from './extract-store.mjs';
// 对外接口不变（调用方零改动）：老路径 ./extract.mjs 仍导出同样的名字
export { LIMITS, buildExtractPrompt, planBatches } from './extract-prompt.mjs';
export { parseExtractResponse } from './extract-parse.mjs';
export { cursorPath, readCursor, renderInboxLines, appendToInbox } from './extract-store.mjs';

/** 取一个会话日志里的用户消息（口径与 ingest 一致：user/message 且 source.kind === 'user'） */
function userTextsFromTranscript(file) {
  const recs = readRecords(file);
  const out = [];
  for (const r of recs) {
    if (r.type !== 'user/message') continue;
    if (r.data?.source?.kind !== 'user') continue;
    const t = textOf(r.data?.content);
    if (t) out.push(t);
  }
  return out;
}

/**
 * 抽一轮候选。**任何失败都返回 `{ok:false}`，绝不抛。**
 * @param {string} dir 仓库目录（只用于日志/落盘位置）
 * @param {{transcript?:string, cwd?:string, texts?:string[], sessionKey?:string, fetchImpl?:Function, config?:object, maxMessages?:number, timeoutMs?:number}} opts
 *   `maxMessages` = **本次最多处理几条**（人工闸门，默认不限）；单批上限固定走 `LIMITS.maxMessages`。
 */
export async function extractCandidates(dir, opts = {}) {
  const t0 = Date.now();
  const cfg = opts.config || loadLlmConfig({ env: opts.env || process.env, files: opts.files });
  // 没配置 ⇒ 立刻返回，**不读也不写游标**（静默跳过；等环境好了照常从原处继续）
  if (!cfg.ok) return { ok: false, reason: cfg.reason, config: cfg, candidates: [], calls: 0, batches: 0, advanced: 0 };
  let texts = opts.texts;
  let key2 = opts.sessionKey ? String(opts.sessionKey) : null;
  if (!texts) {
    const file = opts.transcript || (findTranscripts(opts.cwd || process.cwd())[0] || {}).file;
    if (!file) return { ok: false, reason: '没找到会话日志', config: cfg, candidates: [], calls: 0, batches: 0, advanced: 0 };
    try { texts = userTextsFromTranscript(file); } catch (e) { return { ok: false, reason: '读会话日志失败：' + str(e && e.message), config: cfg, candidates: [], calls: 0, batches: 0, advanced: 0 }; }
    key2 = key2 || cursorKey(file) || null;
  }
  const cursor = key2 ? readCursor(dir) : {};
  const start = Math.min(Math.max(0, Number(cursor[key2]) || 0), texts.length);
  const planned = planBatches(texts, start, {
    maxPerRun: opts.maxMessages ?? Infinity,
    ...(opts.maxPromptChars ? { maxPromptChars: opts.maxPromptChars } : {}),
    ...(opts.batchMessages ? { batchMessages: opts.batchMessages } : {}),
  });
  const base = { config: cfg, from: start, total: texts.length };
  if (!planned.length) {
    return {
      ok: true, reason: null, candidates: [], calls: 0, batches: 0, advanced: 0, pos: start, ...base,
      note: start >= texts.length ? '游标已到末尾（没有新消息）' : '没有用户消息可抽',
    };
  }
  const f = opts.fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') return { ok: false, reason: '运行时没有 fetch', candidates: [], calls: 0, batches: 0, advanced: 0, ...base };
  const timeoutMs = opts.timeoutMs || LIMITS.timeoutMs;
  const candidates = [];
  let calls = 0;
  let batches = 0;
  let pos = start;
  let stopped = null;
  let usage = null;

  for (const b of planned) {
    const part = texts.slice(b.from, b.to);
    const prompt = buildExtractPrompt(part, { maxMessages: part.length });
    let res;
    calls += 1;
    try {
      res = await f(String(cfg.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
          temperature: 0.1,
          max_tokens: LIMITS.maxOutTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const msg = str(e && e.message);
      const timedOut = /abort|timeout|TimeoutError/i.test(msg) || (e && e.name === 'TimeoutError');
      stopped = timedOut ? 'timeout(' + timeoutMs + 'ms)' : '请求失败：' + msg;
      break;
    }
    if (!res || !res.ok) { stopped = 'http ' + (res ? res.status : '?'); break; }
    let body;
    try { body = await res.json(); } catch (e) { stopped = '响应不是 JSON：' + str(e && e.message); break; }
    const content = body?.choices?.[0]?.message?.content;
    const parsed = parseExtractResponse(typeof content === 'string' ? content : JSON.stringify(content ?? ''), { maxCandidates: opts.maxCandidates || LIMITS.maxCandidates });
    if (!parsed.ok) { stopped = parsed.reason; break; }
    usage = body?.usage || usage;
    candidates.push(...(parsed.candidates || []));
    batches += 1;
    pos = b.to;
    // ★ 只有这一批**成功**才推进游标：崩/失败 ⇒ 停在最后成功的那一批末尾，下次从这里继续。
    //   写盘失败也不影响本轮已抽到的候选（只是下次会重抽这一批 —— 重复优于丢失）。
    // ⚠️ `noAdvance`（= 预演 `--dry`/未给 `--write`）：**不推进**。否则"只看了效果、候选没落库"
    //    却把游标推过去 ⇒ 那批消息永久漏掉，与"一条不漏"直接矛盾（2026-11-09 自查发现）。
    if (key2 && !opts.noAdvance) { cursor[key2] = pos; saveCursor(dir, cursor); }
  }
  return {
    ok: batches > 0, reason: stopped, stopped, candidates, calls, batches,
    advanced: pos - start, pos, planned: planned.length, ...base, usage, ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------- CLI 外壳
/** `cli extract [--session <file>] [--max N] [--dry] [--gate 0.5] [--model X]` */
export async function runExtractCli({ opt, log, dir, cwd }) {
  const cfg0 = loadLlmConfig();
  if (!cfg0.ok) {
    log('[extract] 跳过：' + cfg0.reason + '（链路未配置不算失败）');
    return { ok: false, reason: cfg0.reason };
  }
  const model = str(opt('model')) || cfg0.model;
  // 默认只预演（同 sync/prune/rotate 的仓库惯例）：空跑也照样打印候选，便于先看质量再决定写
  const willWrite = !!opt('write') && !opt('dry');
  // `--max N` 是**人工闸门**（本次最多处理几条），默认不限；防漏靠游标+分批，不靠这个上限
  const maxRaw = opt('max');
  const maxPerRun = maxRaw === undefined || maxRaw === true || !Number(maxRaw) ? Infinity : Number(maxRaw);
  log('[extract] 配置：model=' + model + '｜base=' + cfg0.baseUrl + '｜key 来自 ' + cfg0.keyFrom + '（值不打印）');
  const r = await extractCandidates(dir, {
    transcript: str(opt('session')) || undefined,
    cwd,
    config: { ...cfg0, model },
    maxMessages: maxPerRun,
    noAdvance: !willWrite,   // 预演不推进游标（否则候选没落库、消息却被记成"已提取" ⇒ 永久漏）
    timeoutMs: Number(opt('timeout', LIMITS.timeoutMs)) || LIMITS.timeoutMs,
  });
  const meta = '｜共 ' + (r.total ?? 0) + ' 条消息、从第 ' + ((r.from || 0) + 1) + ' 条起'
    + '｜批 ' + (r.batches || 0) + (r.advanced ? '（游标 +' + r.advanced + '）' : '')
    + '｜' + (r.ms || 0) + 'ms｜调用 ' + (r.calls || 0) + ' 次'
    + (r.usage ? '｜tokens in/out=' + (r.usage.prompt_tokens ?? '?') + '/' + (r.usage.completion_tokens ?? '?') : '');
  if (!r.ok) {
    saveExtractLog(dir, { ok: false, reason: r.reason, model, batches: r.batches, advanced: r.advanced });
    log('[extract] ❌ ' + r.reason + meta + '｜未写入 inbox');
    return r;
  }
  if (r.stopped) log('[extract] ⚠️ 中途停了（' + r.stopped + '）—— 游标已推进到第 ' + (r.pos || 0) + ' 条，下次从这里继续');
  log('[extract] 候选 ' + r.candidates.length + ' 条' + meta);
  for (const c of r.candidates) log('  · [' + c.kind + '] ' + clip(c.text, 120) + (c.why ? '　← ' + c.why : ''));
  let out = { written: [], skippedDup: 0, skippedGate: 0 };
  if (!r.candidates.length) { log('[extract] 没有值得入库的候选'); saveExtractLog(dir, { ok: true, model, candidates: [], usage: r.usage, batches: r.batches, advanced: r.advanced }); return { ...r, ...out }; }
  // ⚠️ **默认只预演**（同 `sync` / `prune` / `rotate` 的仓库惯例：默认 dry-run，写盘要显式开口）
  if (!willWrite) {
    log('[extract] 预演：未写 inbox、**游标未推进**（加 --write 才落盘并推进）');
  } else {
    out = appendToInbox(dir, r.candidates, { gate: Number(opt('gate', INBOX_GATE)) });
    log('[extract] 写入 inbox.md ' + out.written.length + ' 条'
      + (out.skippedGate ? '｜被 scoreCandidate 门挡下 ' + out.skippedGate + ' 条' : '')
      + (out.skippedDup ? '｜重复跳过 ' + out.skippedDup + ' 条' : ''));
  }
  saveExtractLog(dir, { ok: true, model, usage: r.usage, candidates: r.candidates, wrote: out.written.length, dry: !willWrite, batches: r.batches, advanced: r.advanced, stopped: r.stopped || null });
  return { ...r, ...out };
}
