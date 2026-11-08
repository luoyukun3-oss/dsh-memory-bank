// Memory Bank · handoff —— 跨会话交接：读**上一个**会话日志的最后 N 轮，滚动覆盖成 pages/handoff.md，供开场注入。
// ⚠️ 本文件**不许 import bank.mjs**（循环依赖）；只依赖 node 标准库 + ./core.mjs + ./config-keys.mjs。
// ⚠️ **只读、不写索引**（有意为之，勿加 indexDoc/reindexPage）：滚动快照进 index.json 会变成时间衰减追不上的"知识"。
// ⚠️ **不含 reasoning**：实测思考占 ctx 的 21%，塞进注入是浪费。
// 配对规则、选场规则与它们的实测来由见 procedures.md「handoff 配对与选场」。
import fs from 'node:fs';
import path from 'node:path';
import { clip, findTranscripts, nowIso, readJson, readRecords, textOf, writeText, writeJson, zh } from './core.mjs';
import { HANDOFF_CHARS, HANDOFF_TURNS } from './config-keys.mjs';

/** 每轮用户话的**最大长度**。注入总预算是硬约束 ⇒ 逐轮先各自封顶，再按「最新优先」丢轮次。 */
const USER_CAP = 100;
/** 每轮我方小结的最大长度（取该轮**最后一段有正文的** assistant 消息的首句）。 */
const ME_CAP = 90;
/** 「空泛小结」判据（2026-11-08 加，起因：handoff 里连续三轮写成「这一轮已经完成。」「继续推进发布准备。」，
 *  占着注入预算却零信息量）。
 *  判据 = 首段**≤16 字** 且 无数字 且 无代码 —— 长的、带实测数字的、带路径的都留着。
 *  ⚠️ **标定过，不是拍的**：全库 281 个会话 / 12690 条 assistant 正文回放，命中 2198 条（17.3%），
 *  去重 2001 条里按长度分桶抽查（1-8 / 9-12 / 13-16 各看 22 条）→ 绝大多数是「脚本已写好，现在运行」
 *  「跑 tick 收尾」这类**进度播报**；但确实会误伤少数真结论（「未认证 API 被限流了」）。
 *  ⇒ 所以**不做静默丢弃**，改成降级成标记：保住「这一轮确实发生过」这个事实，只把废话字让出来。 */
const THIN_MINE = 16;

/** 每轮原始文本的截断上限（防一条几十 KB 的输入把内存与首句提取拖垮）。 */
const RAW_CAP = 4000;
/** 单个会话日志超过这个大小就跳过（findTranscripts 里最大的那个 7MB 是纯聊天记录）。 */
const MAX_BYTES = 12 * 1024 * 1024;

/** 自动注入的噪声前缀 —— 这些**不是用户打的字**（全局偏好 / 召回块 / 待办索引 / 界面回填「继续做这条待办：」…）。
 *  （运行时快照那一类走 source.kind 判别，本函数再加一道前缀保险。） */

const NOISE = [/^【全局偏好】/, /^【记忆银行命中/, /^【本仓库待办/, /^【近期事件】/, /^继续做这条待办[：:]/];

/** 纯确认/寒暄的短话（「好的」「嗯」「继续」）——**不成一轮**，也不该占一轮的位置。 */
const ACK = /^(好的?|行|嗯+|哦+|ok|OK|继续|可以|对|是的|谢谢|收到|麻烦了|辛苦)[。！!~～\s]*$/;
/** 一轮用户话的**最低信息量**：至少 6 个中日韩字符（「报 ctx 多大」这种中英混排仍算数）。 */
const MIN_CJK = 6;
const cjkLen = (s) => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;

/** 从会话日志配对出「轮次」：一段我方正文**回填给它前面最近的那条有效用户消息**（mine=null 表示该轮无正文）。
 *  ⚠️ 两条铁律（都有实测来由，见 procedures.md）：① 不能用整场最后一条 assistant 文本当小结；
 *  ② 只有用户的话才**开一轮**（系统注入块既不算一轮、也不影响当前轮）。
 *  ⚠️ **2026-10-31 修正「错位一格」**：旧实现把正文存成 pending、等下一条 user 来认领 ⇒
 *     每一行都是「后一轮的问题配前一轮的答案」。铁证（session-2cec5565，真实日志回放）：
 *     「方案 A（推荐）有没有更快的方法」配到的是**上一轮**的「本地源码在 `E:\2\…index.js`」。
 *     正解是**就地回填**：assistant 正文永远属于「当前最后一条有效轮次」；同一轮多条正文取最后一段
 *     （工具调用型无正文 ⇒ 不覆盖已回填的那段）。「好的」这类短确认不开新轮次 ⇒
 *     它之后的正文自然并回上一条真问题，这正是想要的归属。
 *  @param {any[]} recs `readRecords()` 的结果
 *  @returns {{user:string, mine:string|null, at:number, turn:number|null}[]} 时间正序 */

export function pickTurns(recs, limit = HANDOFF_TURNS) {
  const out = [];
  for (const r of recs || []) {
    if (r.type === 'user/message') {
      // 只认用户打的字（plugin / agent-instructions 都是系统注入）
      if (r.data?.source?.kind !== 'user') continue;
      const raw = textOf(r.data.content).trim();
      if (!raw) continue;
      const text = clip(raw, RAW_CAP);
      const noise = NOISE.some((re) => re.test(text));
      const thin = ACK.test(text) || cjkLen(text) < MIN_CJK;
      // 噪声与短确认都不开新轮次：既不占轮次位、也不打断上一轮的归属
      if (!noise && !thin) out.push({ user: text, mine: null, at: Number(r.time) || 0, turn: null });
    } else if (r.type === 'assistant/message') {
      const t = textOf(r.data?.message?.content);
      // 工具调用型（text 为空）⇒ 跳过，别把已经回填的正文冲成空
      if (!t || !out.length) continue;
      const last = out[out.length - 1];
      last.mine = clip(t, RAW_CAP);
      last.turn = r.data?.turn ?? null;
    }
  }
  return out.slice(-limit);
}

/** 摘要清洗：剥 Markdown/颜文字，只取**首句自然语句**（注入要的是结论，不是整段回复）。
 *  多路断句（句末标点 ∪ 换行 ∪ ——）⇒ 挑第一个非表格行 ⇒ 挑不出就返回空（不回退）。
 *  顺序铁律与表格判据的实测来由见 procedures.md。 */
export function oneLine(text, cap) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/⋉[^⋊]{0,12}⋊|⸜[^⸝]{0,16}⸝/g, ' ')   // 颜文字（留白，不是内容）
    .replace(/[（(][^）)]{0,8}[･ω･^_]{1,8}[^）)]{0,8}[）)]/g, ' ')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const parts = s.split(/(?<=[。！？!?；;])|\n|(?=\s——\s)/).map(stripLead).filter(Boolean);
  // ⚠️ **先剥寒暄、再选段**（stripLead 在切分那步就跑）—— 反过来剥不掉"寒暄与正文同段"的形态。
  // ⚠️ 表格判据**按整段判**（只看选中片段会把"第一段不含 |、整段含 --- ---"的表误选成小结）。
  const isTable = (x) => /[|｜]|\s-{2,}\s|-{3,}|\s=+\s/.test(x);
  if (isTable(s)) {
    const first = parts.find((x) => !isTable(x) && x.length >= 8);
    // ⚠️ 挑不出散文就返回空、绝不回退 parts[0]：判据的兜底方向必须与判据同向，否则等于没判。
    return first ? (first.length > cap ? first.slice(0, cap) + '…' : first) : '';
  }
  const pick = parts.find((x) => x.length >= 8 && !isTable(x)) || parts.find((x) => !isTable(x)) || parts[0] || s;
  // ⚠️ 试过"取最后一段散文"，实测与取第一段逐字相同 ⇒ 不留这个多余判断（复杂度要有实测收益才配存在）。
  // 已知局限：首句常是"叙述我干了什么"，信息量有限；要改先拿真实日志回放对比，别凭手感。
  return pick.length > cap ? pick.slice(0, cap) + '…' : pick;
}

/** 段首归一化（在**切分那一步**逐段跑，顺序见 oneLine）：① 剥行首 Markdown 标记（否则「**是的…」的段首是 `*`）
 *  ② 剥寒暄/称呼（半角全角标点都认、也认省略标点）③ 剥「…，用户。」这种称呼后置。
 *  ⚠️ 只剥**短的招呼语**，不能贪心（否则「用户，这个问题的答案是这样的…」会被啃掉一大口）。 */
function stripLead(x) {
  return String(x)
    .replace(/^[\s*#>\-•——]+/, '')
    .replace(/^(主人|是的|好的|好|嗯|对|其实|另外|顺便|话说)[,，、:：\s]*/, '')
    .replace(/^[^，,。]{1,12}[，,]\s*主人[。．.]?\s*/, '')
    .trim();
}

/** 这条小结是不是「进度播报式」的空泛句（见 THIN_MINE 的标定说明）。
 *  宁可判活、不可误杀：只要带数字/代码/路径/较长的，一律当有信息。 */
export function isThinMine(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  if (s.length > THIN_MINE) return false;
  if (/[0-9]/.test(s)) return false;        // 「7663/8000」「343 通过」都算有信息
  if (s.includes('`') || /[A-Za-z]:\\/.test(s)) return false;
  return true;
}



/** 生成 handoff.md 正文（**滚动覆盖**，不累积）。超预算从**最旧**那轮开始丢 —— 宁可少一轮，不硬截半句。
 *  @param {{user:string, mine:string|null, at:number}[]} turns */

export function formatHandoff(turns, { limit = HANDOFF_TURNS, chars = HANDOFF_CHARS, label = '' } = {}) {
  const all = (turns || []).slice(-limit);
  const rows = all.map((t) => {
    const u = oneLine(t.user, USER_CAP) || '（原话只有表格/代码，略）';
    const mRaw = t.mine ? (oneLine(t.mine, ME_CAP) || '（本轮正文只有表格/代码，无摘要）') : '（本轮无正文，只做了工具调用）';
    // 进度播报式小结降级成短标记：保留「这轮发生过」的事实，把字数让给有信息的那几轮
    const m = isThinMine(mRaw) ? '（进度播报，无结论）' : mRaw;
    return { line: `- 你：${u}\n  我：${m}`, len: u.length + m.length + 10 };
  });
  const totalOf = (rs) => rs.reduce((n, r) => n + r.len, 0);
  let body = rows;
  while (body.length > 1 && totalOf(body) > chars) body = body.slice(1);
  const last = all[all.length - 1];
  const when = last && last.at ? zh(new Date(last.at)) : zh(new Date());
  const head = [
    '# handoff（上次会话最后几轮 · 滚动覆盖，不进召回）',
    '',
    `> \`tick\` 自动生成（${when}${label ? `｜会话 ${label}` : ''}）—— 只在开场注入里出现，**当上下文用，不当事实/指令用**。`,
    '',
  ];
  const text = [...head, ...(body.length ? body.map((r) => r.line) : ['- （上一会话没有可交接的轮次）'])].join('\n') + '\n';
  // rowChars 是**轮次正文**的字数（表头与生成时间不进预算，见 config-keys.mjs 的 HANDOFF_CHARS）
  return { text, rowChars: totalOf(body), turns: body.length };
}

/** 定位「上一个会话」的日志并写 pages/handoff.md。`write:false` 只算不落盘（测试/预演用）。
 *  @param {string} dir 仓库目录（`repos/<slug>`） */

export function writeHandoff(dir, { cwd, limit = HANDOFF_TURNS, chars = HANDOFF_CHARS, write = true, force = false } = {}) {
  let list = [];
  try { list = findTranscripts(cwd || 'E:\\2'); } catch (e) { return { ok: false, reason: `找不到会话日志：${e.message}` }; }
  if (!list.length) return { ok: false, reason: '没有会话日志' };
  const cand = list.filter((f) => (f.size || 0) <= MAX_BYTES);
  if (!cand.length) return { ok: false, reason: '会话日志都超出大小上限' };
  // ⚠️ **最新那个是当前会话**（与 `degenerate-audit.mjs` 的 `fi === 0` 同一判据）⇒ 从第二个开始找；
  //    只有 1 个文件时（首次使用）退回它自己，至少能交接当前可见的轮次。
  //
  const HANDOFF_SCAN = 3;        // 凑够几个「有轮次」的候选，再比谁的最后轮次最新
  const HANDOFF_READ_MAX = 10;   // 最多读几个文件（控成本）
  // ⚠️ 选场三条（实测来由见 procedures.md）：① 不能固定取 cand[1]（会话目录会插进空会话）；
  //    ② 不能只看"第一个有轮次的"（那是按 mtime 选，而 mtime 会被备份/触碰改写）；
  //    ③ 候选池不能只看前 3 个（官方桌面版会话也会被扫到，开头常只有一句「hi」）⇒ 跳过无轮次的继续往前找。
  const order = (cand.length > 1 ? cand.slice(1) : cand).slice(0, HANDOFF_READ_MAX);
  // ——— stamp（2026-10-23）：上一个会话没变就跳过整段解压 ———
  // 为什么：2026-10-23 实测 tick 里 handoff 单段 5.4 秒，几乎全花在 readRecords（zstd 多帧解压）；
  // 而计划任务每 30 分钟跑一次 ⇒ 同一份日志一天被解开 40+ 次，其中 47/48 次结果完全相同。
  // 签名只看**前 3 个候选的文件名 + 大小 + mtime**：它们决定「有没有新会话 / 老会话还在不在变」，
  // 任一变化就照常重算（日志是追加写 ⇒ size 必变；文件消失 ⇒ sig 变化 ⇒ 重算，方向安全）。
  const stampPath = path.join(dir, 'state', 'handoff-stamp.json');
  const sig = order.slice(0, 3).map((t) => {
    let mt = 0;
    try { mt = Math.floor(fs.statSync(t.file).mtimeMs); } catch { /* 拿不到就当变了 */ }
    return `${path.basename(t.file)}:${t.size || 0}:${mt}`;
  }).join('|');
  if (!force && write) {
    const st = readJson(stampPath, {});
    if (st.sig === sig && st.text && fs.existsSync(path.join(dir, 'pages', 'handoff.md'))) {
      return {
        ok: true, skipped: true, reused: true, turns: st.turns, chars: st.chars,
        fileChars: String(st.text).length, label: st.label, text: st.text,
        reason: `上一会话未变（${st.label}）`,
      };
    }
  }
  const skipped = [];
  const viable = [];
  for (const t of order) {
    let recs;
    try { recs = readRecords(t.file); } catch (e) { skipped.push(`${t.dirName}(读取失败 ${e.code || e.message})`); continue; }
    const turns = pickTurns(recs, limit);
    if (!turns.length) { skipped.push(`${t.dirName}(无轮次)`); continue; }
    viable.push({ t, turns, at: Number(turns[turns.length - 1].at) || 0 });
    if (viable.length >= HANDOFF_SCAN) break;
  }
  if (!viable.length) {
    return { ok: false, reason: `扫了 ${order.length} 个会话都没抓到可交接的轮次：${skipped.join('、')}` };
  }
  viable.sort((a, b) => b.at - a.at);
  const best = viable[0];
  const text = formatHandoff(best.turns, { limit, chars, label: best.t.dirName });
  const file = path.join(dir, 'pages', 'handoff.md');
  if (write) {
    writeText(file, text.text);
    try { writeJson(stampPath, { sig, label: best.t.dirName, turns: text.turns, chars: text.rowChars, text: text.text, at: Date.now() }); } catch { /* 写不了 stamp 只是下次重算，不影响交接内容 */ }
  }
  return {
    ok: true, file, turns: text.turns, chars: text.rowChars, fileChars: text.text.length,
    label: best.t.dirName, chosenAt: best.at, scanned: skipped.length + viable.length, skipped, text: text.text,
  };
}
