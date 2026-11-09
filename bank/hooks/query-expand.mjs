// ⑪ 短查询「接续性提问」扩展：判定 + 拼接上一轮用户话
// ============================================================================
// 为什么需要（2026-11-08，笔记第五轮 15.3）：LivingMemory 检索时**用最近几条消息拼查询**，
//   而我们的 hook 只拿当前这一句召回 ⇒ 「那这个呢」「他说的那个」这类接续性提问召回不到 ——
//   实测原句 `那这个呢` 在 e-2 库 **hits=0**（tokenize 出来是 `那这/这个/个呢`，全是虚词 bigram），
//   而拼上上一轮用户话后能命中同一话题的记忆。
//
// ⚠️ 先说清「⑪ 一开始就 PRONOUN_HEAD 降权」这个说法**不对**（2026-11-08 实测查证）：
//   `PRONOUN_HEAD` 在 `ingest.mjs` 的 `scoreCandidate` 里，唯一调用点是 `ingest.mjs:245`
//   （`if (scoreCandidate(u.text) < INBOX_GATE) continue;`）—— 那是**投递门**（决定这条要不要
//   写进 inbox），跟**检索**（recall/search.mjs）毫无关系。检索侧完全不知道指代词。
//   ⇒ 本文件借用的只是**同一张指代词表**（保持一处语义、两处一致），不是「沿用降权逻辑」。
//
// ## 本模块只做纯判定与拼接，不碰召回
//   召回与降级在 `user-prompt.mjs`（那里才有 dir 与 MIN_SCORE）。这样这个文件**零 IO 副作用**
//   （只读一个 live json），可以单测、也可以被别的入口复用。
//
// ## 上一轮消息从哪来（这是本改法的**前提**，已验证）
//   hook 的 payload 只有 `cwd / session_id / prompt / hook_event_name`（由 profile 插件
//   `dsh-memory-bank-live` 的 `agent/pre-step` 拼出来，见它的 `src/index.js:307,327`），
//   **没有 transcript_path、没有 messages**。唯一廉价的历史来源是
//   `_dsh_memory/live/<session_id>.json` 的 `userMsg` —— 由**上一轮**的本 hook 的 `touchLive`
//   写入（`live.mjs:58`，截到 60 字），而本轮 `touchLive` 在召回**之后**才覆盖它
//   （`user-prompt.mjs` 的 touchLive 在 recall 之后）⇒ 召回此刻读到的正是**上一轮**的原话。
//   ⚠️ 替代方案（解压本会话 `session.v4.jsonl.zstd`）实测 35ms/0.32MB，长会话 5.5MB 会到几百 ms，
//      而 hook 每轮都跑 ⇒ 不用它。live 文件 302 字节，成本可忽略。
import fs from 'node:fs';
import path from 'node:path';

/** 触发扩展的当前 prompt 长度上限（含）。与 ingest.mjs 的「短句」阈值同源，12 是那边实测调的。 */
const EXPAND_MAX_CHARS = 12;
/** 上一轮少于这么多字就没信息量（`继续`/`？`/`/bg` 这类），拼了纯属加噪。 */
const PREV_MIN_CHARS = 6;
const PREV_MAX_CHARS = 90;   // 拼进 query 的上一轮文本上限（live 里本来 ≤60，这里只是兜底）

// 指代开头 = 典型接续句。表与 `ingest.mjs:96` 的 PRONOUN_HEAD 一致，另加「刚才/刚说」
// （用户口语里「刚才那个呢」是标准接续句，原表没有）。
// ⚠️ `其` 必须写成 `其(?!实)`：原表把「其实」也吃进去了 —— 66 个真实会话的轮次回放里，
//   「其实是刚打开」被判成接续句（其实＝副词，不是代词）。那边只降权、误判代价小；这边要拼检索，
//   误判会把无关的上一轮拼进来，所以要排掉。
const PRONOUN_HEAD = /^\s*(他|她|它|他们|她们|它们|这|那|这个|那个|这些|那些|这样|那样|刚才|刚说|上面|下面|前面|后面|其(?!实)|此|该)/;
// 有锚点 = 说清了主题，不需要拿上一轮补（单数字也算锚点：有数字多半自带主题，宁可少触发）。
// ⚠️ 与 ingest.mjs:97 的 HAS_ANCHOR 不同：那边是 `\d{2,}`（两年数以上），这边收紧到 `\d`，
//   因为**误触发的代价**（多跑一次 recall + 可能注入上一轮噪声）高于漏触发的代价（退回现状）。
const HAS_ANCHOR = /[\\/][\w.-]+\.\w+|`[^`]+`|[\w-]+\.(py|mjs|js|md|json|ya?ml|txt|html|docx?|css|ps1|cmd)\b|\d/;
// 偏好/情感陈述不是接续句：「她喜欢先看代码」7 字代头，但是完整偏好（同 ingest.mjs:98 的白名单）。
const IS_PREFERENCE = /喜欢|不喜欢|讨厌|习惯|想要|希望|偏好|愿意|爱用|不用|以后/;

// 上一轮若是壳/调度器塞进来的文本（不是用户打的字），拼进去纯属加噪 ⇒ 视为「没有上一轮」。
// 实测依据（66 个真实会话 / 716 轮回放）：21 条触发里 9 条的「上一轮」是这类东西 ——
//   `Current runtime context. This snapshot supersedes…`、`[model changed: …]`、
//   `[SCHEDULE REMINDER BATCH] …`。它们和真人原话一样是 role=user 的消息，光看 role 分不出来。
const SYS_PREV = /^\s*[<[]|^Current runtime context/i;

/** 清洗上一轮文本：剥注入标签（`<system-reminder>` 之类）、折叠空白、截断；系统文本一律当无效。 */
function cleanPrev(prev) {
  const s = String(prev || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (SYS_PREV.test(s)) return '';
  return s.slice(0, PREV_MAX_CHARS);
}

/**
 * 读本会话**上一轮**的用户消息（`live/<sessionId>.json` 的 `userMsg`）。
 *
 * ⚠️ 任何失败一律返回空串 —— 调用方据此退化成现状。**绝不抛**：
 *   本函数在 hook 主 try 里，抛出去会连累整条注入（历史事故见 core.mjs:218 附近的注释）。
 * ⚠️ 文件名规则与 `live.mjs` 的 fileNameOf 相同（sessionId 一般是 UUID，理论上无害），
 *   那边若改规则这里要同步 —— 复制规则而不是 import，是为了不把 live.mjs 的 TTL/写逻辑拖进热路径。
 * @param root `_dsh_memory` 根
 * @param sessionId payload.session_id
 */
export function readPrevUserMsg(root, sessionId) {
  try {
    const id = String(sessionId || '');
    if (!id) return '';
    const f = path.join(String(root || ''), 'live', `${id.replace(/[^\w.-]/g, '_')}.json`);
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return typeof o?.userMsg === 'string' ? o.userMsg : '';
  } catch {
    return '';
  }
}

/**
 * 判断要不要扩展，并给出拼接后的 query。
 *
 * 四道门（全部满足才触发）：① 短（≤12 字）② 指代开头 ③ 无锚点 ④ 不是偏好陈述；
 * 另加两道**上一轮**的门：⑤ 上一轮有效（≥6 字、清洗后非空）⑥ 上一轮与当前不重复（拼了也不涨信息）。
 *
 * @param prompt 当前用户输入（payload.prompt）
 * @param prev 上一轮用户消息（readPrevUserMsg 的返回值）
 * @returns `{ query, prev }`，不触发则 `null`
 */
export function planExpansion(prompt, prev) {
  const cur = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!cur || cur.length > EXPAND_MAX_CHARS) return null;
  if (!PRONOUN_HEAD.test(cur)) return null;
  if (HAS_ANCHOR.test(cur)) return null;
  if (IS_PREFERENCE.test(cur)) return null;
  const p = cleanPrev(prev);
  if (p.length < PREV_MIN_CHARS) return null;
  if (p.includes(cur) || cur.includes(p)) return null;   // 同一句话（上一轮就是它）就别拼了
  return { query: `${p} ${cur}`, prev: p };
}
