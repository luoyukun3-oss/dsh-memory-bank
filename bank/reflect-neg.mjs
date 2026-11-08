// ============================================================================
// Memory Bank · reflect-neg —— 「负面反馈候选」扫描（2026-10-28）
//
// 为什么独立成模块：reflect.mjs 已 196/220 行，加不进 30 行；预算表的规矩是
//   「超限先按域拆分，别压缩行宽硬塞」（budgets.json 原话）。这里只做一件事：
//   从用户原话里挑出「用户指出了问题、但没明说要记账」的那几条，**只列候选、不落库**。
//
// 对应待办：todos.md「tick 反思加『负面指出词』扫描」的**第②层·事后层**。
//   第①层（hooks/ledger-cue.mjs）只在用户**明说**「塞进收件箱」时才提醒；
//   这里补的是「指出了问题、却没说要记账」的情形 —— 那种最容易随风飘走。
//
// ⚠️ 判据刻意**宽**：误报的代价 = 反思页多一行候选（还要人判断才会进 inbox.md）；
//    漏报的代价 = 又一次靠用户催。所以只排除三类噪声：
//    ① 像代码的（同 reflect.mjs 第三节的教训：别把粘贴的代码当纠正）
//    ② 过长的（多半是整段粘贴/长文，不是一句话的指正）
//    ③ 第①层已处理的（明确带记账指令，避免重复催）
//
// ⚠️ 2026-10-28 真实回放（最近 7 天 246 条用户消息）实测：
//    裸词表命中 9 条。曾试过加「必须含『你』」的指向过滤 → 只剩 2 条，
//    **把两条真问题误杀**（「不对下载进度条也没转起来」「不对git收件箱有问题」）
//    —— 用户纠正时**常不带『你』**，故该过滤条件已废弃，宁可宽。
// ============================================================================
import { clip } from './core.mjs';

/** 待办里给的词表（用户 2026-10-26 那轮的原始清单） */
const NEG_WORDS = ['划掉', '断了', '卡住', '没做到', '没生效', '没反应', '又是', '怎么还', '不对', '错了', '漏了', '忘了'];

const RE_NEG = new RegExp(NEG_WORDS.join('|'));
/** 第①层的「记账指令」—— 命中的话已由 hooks/ledger-cue.mjs 提醒过，这里不要重复 */
const RE_LEDGER = /(?:塞进|塞到|记进|记到|写进|写到|放进|放到|加进|加到|落进|落盘|存进|存入)[^。\n]{0,8}(?:教训箱|教训收件箱|教训页|收件箱|inbox|台账)/i;
/** 像代码的（与 reflect.mjs 第三节同一套判据，别漂移） */
const CODEISH = /[=(){}[\];]|\bdef\b|\bprint\b|\bwhile\b|\bfor\b|\bint\(|\bimport\b|Traceback/;

/**
 * 从用户原话里挑「负面反馈候选」。
 * @param {string[]} userTexts 已剥掉时间戳/标记的用户正文
 * @returns {string[]} 最多 8 条，保持原顺序（旧→新）
 */
export function scanNegFeedback(userTexts = [], { limit = 8, maxLen = 150 } = {}) {
  return (Array.isArray(userTexts) ? userTexts : [])
    .filter((l) => RE_NEG.test(l))        // 命中负面指出词
    .filter((l) => l.length <= maxLen)    // 过长多半是长文/粘贴，不是一句话的指正
    .filter((l) => !CODEISH.test(l))      // 像代码的
    .filter((l) => !RE_LEDGER.test(l))    // 第①层已处理
    .slice(-limit);
}

/**
 * 渲染成反思页的「六」节（纯函数，返回行数组，不写盘）。
 * @param {string[]} list scanNegFeedback 的结果
 */
export function renderNegSection(list = []) {
  const out = ['## 六、负面反馈候选（主人指出问题、但没明说要记账的）', ''];
  if (list.length) {
    out.push('> 判据：命中 `' + NEG_WORDS.join('/') + '`，且非代码片段、非长文、非第①层已处理的。**只是候选**，确认成立再落 `inbox.md`。');
    out.push('');
    for (const c of list) out.push(`- ${clip(c, 160)}`);
    out.push('');
    out.push('> 成立的：`cli remember "<要点>" --page inbox.md`；不成立的直接忽略（词表命中不等于我错了，也可能是主人在问别的事）。');
  } else {
    out.push('（无：最近没有明显被指出、又没记账的问题）');
  }
  out.push('');
  return out;
}
