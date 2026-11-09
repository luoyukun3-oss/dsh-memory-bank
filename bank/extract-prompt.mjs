// ============================================================================
// Memory Bank · extract-prompt —— 抽取域「喂给模型什么」（2026-11-09 从 extract.mjs 按域拆出）
//
// 为什么拆：extract.mjs 加完「游标 + 分批」后实测 **350/360（97%）**，逼近 budgets.json 的
//   架构红线。按项目原则「只许瘦不许胖，超限先按域拆，别压缩行宽硬塞」（先例：extract-config.mjs）。
//   本文件只装三件**同域**的事，全部是纯函数、无 I/O、不碰网络：
//     ① 成本护栏常量 LIMITS（改这里就等于改账单）
//     ② 系统提示词 SYSTEM_PROMPT（哪些该收、哪些坚决不收）
//     ③ 分批 buildExtractPrompt / planBatches（从旧到新切，不丢消息）
//
// ⚠️ 本模块是抽取域的**最底层**（不 import 域内其它文件）：str 也在这里定义、给域内共用 ——
//   别再各抄一份，「同一判据抄两份」的漂移史见 evstore.mjs 里 linkEntities 的警语。
// ============================================================================
import { clip } from './core.mjs';
/** 成本护栏（改这里就等于改账单，动之前先算一遍） */
export const LIMITS = {
  maxMessages: 30,        // 一次最多喂多少条用户消息
  maxCharsPerMsg: 300,    // 单条截断
  maxPromptChars: 8000,   // prompt 总长上限（超了从最早的消息开始丢）
  maxOutTokens: 1200,     // 输出限长（够放 10 条候选 + 思考预算）。⚠️ 2026-11-09 实测：
                          //   DeepSeek 系的 reasoning tokens **算在 max_tokens 里** —— 只喂 2 条消息时
                          //   completion 244 里有 211 是 thinking，正文只占 33。原值 800 在多候选时会挤掉正文。
  timeoutMs: 30000,       // 硬超时。⚠️ 2026-11-09 实测：同一 provider 三次调用里**有一次 20 秒没回**
                          //   （另两次 4.7s / 6.0s），所以 20s 偏紧、判成 timeout。放宽到 30s；
                          //   超时值仍是个硬上限 —— 宁可这一次抽不到，也不让 CLI 无限挂着。
  maxCandidates: 10,      // 最多收几条
  maxTextChars: 500,      // 单条候选正文上限
  maxWhyChars: 100,       // 单条理由上限
};

/** 统一 trim 成字符串（域内共用；undefined/null → ''）。原样从 extract.mjs 搬来，只是加了 export */
export const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

const SYSTEM_PROMPT = [
  '你是「记忆银行」的抽取器。输入是主人（用户）说过的话，逐条编号。',
  '任务：挑出**长期有价值**、值得写进长期记忆的条目。',
  '',
  '收录（kind 四选一）：',
  '- preferences：偏好、口味、习惯、明确要求（"以后都…""少用…""我喜欢…"）',
  '- todos：还没做完的事、待办、承诺（"还没…""下次…""回头…"）',
  '- environment：本机环境事实（路径、版本、端口、代理、解释器、已装工具）',
  '- lessons：踩坑与结论（报错**且有原因或修法**、教训、被证伪的旧认识）',
  '',
  '坚决不收（这是历史误抓的主力）：',
  '- 提问（"…吗""怎么…""是不是…"）—— 提问是请求，不是知识',
  '- 指令 / 任务书（"帮我…""解析一下…""你是一个…""任务：…"）',
  '- 过程播报 / 我的自述（"我已经…""本次新增…"）',
  '- 只有路径或只有报错、没有结论的碎片',
  '- 界面回填与定时派发文本（"继续做这条待办：…""【定时待办】…"）',
  '',
  '输出要求：**只输出一个 JSON 数组**，不要解释、不要 markdown 代码块。元素形如',
  '{"kind":"preferences","text":"改写成一行的要点（保留主人的关键原词，不要编造）","why":"为什么值得留（不超过 40 字）"}',
  '没有值得留的就输出 []。',
].join('\n');

/**
 * 拼**一批**的 prompt。`texts` 是已经切好的一批（切法见 `planBatches`）。
 * ⚠️ 2026-11-09 改：原来 `slice(-maxMessages)` 取**最近** 30 条 ⇒ 长会话前半永远提取不到
 *    （83 条消息的会话，前 53 条永不入镜）。现在取 `slice(0, maxMessages)`（从旧到新），
 *    "从哪一条开始"由**游标**决定、`maxMessages` 退化为**单批上限**。
 * @returns {{system:string, user:string, used:number, dropped:number}}
 */
export function buildExtractPrompt(texts, { maxMessages = LIMITS.maxMessages, maxPromptChars = LIMITS.maxPromptChars } = {}) {
  const list = (texts || []).map((t) => clip(String(t || ''), LIMITS.maxCharsPerMsg)).filter(Boolean);
  let picked = list.slice(0, maxMessages);
  let dropped = list.length - picked.length;
  const len = () => picked.reduce((n, t) => n + t.length + 8, 0);
  // 兜底：单批仍超长（正常不会，planBatches 已按字数切过）⇒ 从**尾部**丢，保持从旧到新的顺序
  while (picked.length > 1 && len() > maxPromptChars) { picked = picked.slice(0, -1); dropped += 1; }
  const user = picked.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return { system: SYSTEM_PROMPT, user, used: picked.length, dropped };
}

/**
 * 把 `texts[start..]` 切成若干批：每批 **≤ batchMessages 条 且 ≤ maxPromptChars 字**。
 * 为什么需要它：原来只有"取最近 30 条"一道闸 ⇒ 要么漏（超 30 条），要么爆 prompt。
 * 现在改成"切成多批、逐批跑、逐批推进游标" —— 主人 2026-11-09 明确要的是「不要为了省钱留会漏的上限」。
 * @returns {Array<{from:number, to:number}>} 半开区间 [from, to)
 */
export function planBatches(texts, start = 0, { batchMessages = LIMITS.maxMessages, maxPromptChars = LIMITS.maxPromptChars, maxPerRun = Infinity } = {}) {
  const list = texts || [];
  const out = [];
  let i = Math.max(0, Number(start) || 0);
  const limit = Number.isFinite(maxPerRun) ? Math.max(0, Number(maxPerRun)) : Infinity;
  const stop = Math.min(list.length, i + limit);
  while (i < stop) {
    let j = i;
    let chars = 0;
    while (j < stop && j - i < batchMessages) {
      const n = clip(String(list[j] || ''), LIMITS.maxCharsPerMsg).length + 8;
      if (j > i && chars + n > maxPromptChars) break;   // 至少收一条，否则字数上限小于单条时会死循环
      chars += n;
      j += 1;
    }
    out.push({ from: i, to: j });
    i = j;
  }
  return out;
}
