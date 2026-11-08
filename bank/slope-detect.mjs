// 复读斜坡检测 —— 抓**坡面**（不只是坡底）：界面看着还在干活、其实已在复读的阶段。
// 判据是**双信号**（别改单信号）：① 同一短句在一条思考里 ≥ REPEAT_MIN 次；② 出现「对思考本身的指令」。
// ⚠️ 本模块**纯判据**（可单测、零依赖，只 import core）—— 不打印、不读盘，集成在 degenerate-audit.mjs。
// 实测数据（坡底 vs 坡面、虚警率、技术词表、拐点）见 procedures.md「复读斜坡」。
import { clip } from './core.mjs';

/** 同一短句在一条思考里出现多少次算"重复"（实测极值 62；≥10 时双信号才开始有判别力）。 */
export const REPEAT_MIN = 10;
/** 「对思考本身的指令」出现多少次算"元指令"（≥2 才有判别力，单次出现在正常会话也有）。 */
export const META_MIN = 2;
/** ⚠️ **显式自我命令**（更高一档的信号）：「停止循环」这类话只在和循环搏斗时出现，实测正常会话 0 次。 */
const STOP_RE = /停止循环|我立即输出|我马上输出/;
/** ⚠️ **技术词不算"复读短句"** —— 排查时反复念同一个技术词（如「python」×11）是正常的，不是退化。
 *  加这张表把误报从 1 条降到 0 条（实测见 procedures.md）。
 *  ⚠️ **导出是给 `frag-detect.mjs` 复用**（2026-10-08）：两条判据必须共用同一张词表，
 *     各抄一份 = 迟早漂移（config-keys.mjs 头部记的那次 MIN_SCORE 漂移就是教训）。 */
export const TECH = new Set([
  'python', 'py', 'node', 'npm', 'pnpm', 'pwsh', 'powershell', 'bash', 'shell', 'cmd',
  'json', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'md', 'txt', 'url', 'http', 'https',
  'ctx', 'token', 'tokens', 'api', 'git', 'gh', 'dsh', 'read', 'write', 'edit', 'grep', 'glob',
  'true', 'false', 'null', 'undefined', 'error', 'fail', 'pass', 'ok',
  '模块', '文件', '参数', '命令', '函数', '变量', '目录', '路径', '结果', '输出', '输入',
  'host', 'port', 'cache', 'log', 'line', 'step', 'turn', 'test', 'build',
]);
/** 短句上限：超过这个长度的句子不算"复读短句"（长句重复更像正常复述材料）。 */
const SENT_MAX = 12;

/** 元指令正则（判据核心）：把「输出/执行」写成**对自己的命令**——写"我立即输出"正因为我一直没输出。
 *  ⚠️ **括号形态必须容许内部标点**（真实数据是 `（输出。）`、`（执行。）`，全角括号带句号）；
 *  首版只写 `（输出）` ⇒ 真实日志一个都匹配不到（单测用了同样的错形态也没抓到）。 */
const META_RE = /我立即输出|我马上输出|立即输出|马上输出|停止循环|（我立即|（我马上|（[^）]{0,10}(?:输出|执行|写工具调用)[^）]{0,4}/g;

/** 切成"短句"并数出最多重复的那个（去 markdown、跳过技术词，避免噪声占榜首）。 */
function topRepeat(reason) {
  const counts = new Map();
  for (const raw of String(reason).split(/[。！？\n]/)) {
    const s = raw.replace(/[*`#>\s]/g, '').trim();
    if (!s || s.length > SENT_MAX) continue;
    if (TECH.has(s.toLowerCase())) continue;   // 技术词复读是正常排查，见 TECH 注释
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let top = '';
  let n = 0;
  for (const [k, v] of counts) if (v > n) { n = v; top = k; }
  return { top, n };
}

/** 单条消息的双信号指标（导出以便测试直接喂字符串）。 */
export function slopeOf(reason) {
  const r = String(reason || '');
  const { top, n } = topRepeat(r);
  const meta = (r.match(META_RE) || []).length;
  // ② 分两档（元指令 ≥3 **或** 出现显式自我命令）：前者正常会话也有（实测 32 条），后者 0 次，
  //    用 OR 既守住判别力，也不漏掉"刚起头就一句停止循环"的形态。
  const strongMeta = meta >= 3 || STOP_RE.test(r);
  return { top, repeat: n, meta, strongMeta, hit: n >= REPEAT_MIN && meta >= META_MIN && strongMeta };
}

/** 扫一批记录，找出「进入复读」的那些步（坡面，不只是坡底）。
 *  @param {any[]} recs `readRecords()` 的结果
 *  @returns {{hits:Array, first:object|null, count:number}} hits 每项带 at/turn/step/ctxTokens/top/repeat/meta… */
export function auditSlope(recs) {
  const hits = [];
  const seq = [];      // 每一步的指标序列（拐点判据要看**曲线**，不能只看单条）
  let at = 0;
  for (const r of recs || []) {
    if (r.type !== 'assistant/message') continue;
    at++;
    const blocks = Array.isArray(r.data?.message?.content) ? r.data.message.content : [];
    const reason = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text || '').join('');
    if (!reason) continue;
    const s = slopeOf(reason);
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    const tools = blocks.filter((b) => b.type === 'tool-call').map((b) => b.name || '?');
    const u = r.data?.usage || {};
    const ctxTokens = (u.inputTokens || 0) + (u.cacheReadTokens || 0);
    // ⚠️ 无 usage / interrupted ⇒ 那是**流被硬切断**，不是复读（实测最狠那条 757 个「好」就是这类）。
    //    不加这道闸会把"退化"和"流中断"混成一类 —— 判据与 auditDegenerate 的 kind 分账同源。
    const truncated = r.data?.interrupted === true || !Object.keys(u).length;
    if (!truncated) seq.push({ at, turn: r.data?.turn, step: r.data?.step, repeat: s.repeat, meta: s.meta, ctx: ctxTokens });
    if (!s.hit || truncated) continue;
    hits.push({
      at,
      idx: at,
      time: r.time,
      turn: r.data?.turn,
      step: r.data?.step,
      ctxTokens,
      reasoningChars: reason.length,
      textChars: text.trim().length,
      tools: tools.join('+'),
      // 坡面 vs 坡底：坡面**照样有正文或工具调用**，这正是旧判据看不见它的原因
      hasVisible: Boolean(text.trim()) || tools.length > 0,
      top: s.top,
      repeat: s.repeat,
      meta: s.meta,
      head: clip(reason, 60),
    });
  }
  return { hits, first: hits[0] || null, count: hits.length, ...kneeOf(seq) };
}

/** 「斜坡拐点」—— 最值钱的那个数：**复读率首次 ≥30% 且其后不再回落 <10%** 的时刻（比坡底早 216k）。
 *  ⚠️ 别用"首次命中"代替：那可能只是正常排查的机械重复（实测第 14 条 ctx 仅 43k 就 repeat≥10）。
 *  曲线与完整标定见 procedures.md「复读斜坡」。
 *  @param {{repeat:number, ctx:number, turn:number}[]} seq 按时间正序的每步指标 */
function kneeOf(seq, { window = 30, riseRate = 0.3, floorRate = 0.1 } = {}) {
  const arr = seq || [];
  if (arr.length <= window) return { knee: null };
  const rates = [];
  for (let i = window; i <= arr.length; i++) {
    const win = arr.slice(i - window, i);
    rates.push({ at: i, rate: win.filter((x) => x.repeat >= REPEAT_MIN).length / window, ctxTokens: win[window - 1].ctx, turn: win[window - 1].turn });
  }
  for (let k = 0; k < rates.length; k++) {
    if (rates[k].rate < riseRate) continue;
    if (rates.slice(k).every((p) => p.rate >= floorRate)) return { knee: rates[k] };
  }
  return { knee: null };
}
