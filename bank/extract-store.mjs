// ============================================================================
// Memory Bank · extract-store —— 抽取域「碰磁盘的那一半」（2026-11-09 从 extract.mjs 按域拆出）
//
// 为什么拆：同 extract-prompt.mjs（350/360 逼近红线 ⇒ 按域拆，不压缩行宽）。
//   这里装三件都会**落盘**的事 —— 主流程（extractCandidates / runExtractCli）只管编排与打印：
//     ① 游标 extract-cursor.json：哪条消息已经提过（saveCursor / cursorKey 一并搬来，供主流程 import）
//     ② 候选 → pages/inbox.md：只碰这一页，走 scoreCandidate 门 + 三方去重
//     ③ state/extract-last.json：本轮抽取记录，事后查「模型到底说了什么」
//
// ⚠️ 游标**单独一个文件**、不复用 state.json 的 offsets/stamps —— 踩过：ev 复用 ingest 的 stamps，
//   因为 ingest 先跑而误判「已完成」，事件永不落库。
// ============================================================================
import path from 'node:path';
import { clip, day, fingerprint, nowIso, readJson, readText, writeJson, writeText } from './core.mjs';
import { INBOX_GATE, scoreCandidate } from './ingest.mjs';   // 复用现有判据，绝不另写一套
import { LIMITS, str } from './extract-prompt.mjs';

// ---------------------------------------------------------------- 游标（2026-11-09）
// ⚠️ **单独一个文件、不复用** `state.json` 的 offsets / stamps：
//   2026-11-09 刚踩过 —— ev 复用 ingest 的 stamps，因为 ingest 先跑而误判"已完成"，事件永不落库。
// 键 = **会话目录名**（sessions/--E-2--/<sessionId>/session.v*.jsonl.zstd 的那一层）
// 值 = 该会话的**用户消息序号**（= 下一条待提取的位置；0 表示一条都没提过）
const CURSOR_FILE = 'extract-cursor.json';
export const cursorPath = (dir) => path.join(dir, 'state', CURSOR_FILE);
/** 读游标（坏了当空表，不抛） */
export function readCursor(dir) { return readJson(cursorPath(dir), {}); }
/** 写游标（记账不拖垮主流程；返回是否写成功） */
export function saveCursor(dir, cur) { try { writeJson(cursorPath(dir), cur); return true; } catch { return false; } }
/** 会话身份：取日志目录名（sessionId），比绝对路径稳（换机器/换盘符都不变） */
export function cursorKey(transcriptFile) { return path.basename(path.dirname(String(transcriptFile || ''))); }


/** 候选 → inbox 行（沿用现有格式 `- <日期> [<页>] <内容>`，方括号里加 `·LLM` 标来源） */
export function renderInboxLines(candidates, { date = day() } = {}) {
  return (candidates || []).map((c) => '- ' + date + ' [' + c.kind + '·LLM] ' + clip(str(c.text), LIMITS.maxTextChars));
}

/**
 * 写进 `pages/inbox.md`（**只碰这一页**）：与箱内现有内容、`discarded.json` 三方去重。
 * @returns {{written:string[], skippedDup:number, skippedGate:number}}
 */
export function appendToInbox(dir, candidates, { gate = INBOX_GATE, score = scoreCandidate, date = day() } = {}) {
  const pf = path.join(dir, 'pages', 'inbox.md');
  const head = '# inbox（自动记录的待整理素材）\n\n> 自动抓到的候选，**未经验证**；由助手在会话里判断后移入对应知识页，然后从这里删掉。\n';
  const prev = readText(pf) || head;
  const seen = new Set((readJson(path.join(dir, 'discarded.json'), { items: [] }).items || []).map(fingerprint));
  const kept = [];
  let skippedDup = 0;
  let skippedGate = 0;
  for (const c of candidates || []) {
    const line = clip(str(c.text), LIMITS.maxTextChars);
    if (!line) continue;
    // ① 复用现有置信度门（LLM 也会给出提问/指令，别信它的自我判断）
    if (score(line) < gate) { skippedGate += 1; continue; }
    // ② 与箱内现有条目、丢弃记录、本轮已收的 三方去重（都用同一个 fingerprint 口径）
    const fpv = fingerprint(line);
    if (seen.has(fpv) || prev.includes(line.slice(0, 50))) { skippedDup += 1; continue; }
    seen.add(fpv);
    kept.push({ ...c, text: line });
  }
  if (kept.length) {
    const rows = renderInboxLines(kept, { date });
    writeText(pf, prev.replace(/\s+$/, '') + '\n\n' + rows.join('\n') + '\n');
  }
  return { written: kept.map((c) => c.kind + ': ' + c.text), kept, skippedDup, skippedGate };
}

/** 落一份本轮的抽取记录（有界：最多 maxCandidates 条），便于事后查「模型到底说了什么」 */
export function saveExtractLog(dir, rec) {
  try {
    writeJson(path.join(dir, 'state', 'extract-last.json'), { at: Date.now(), atIso: nowIso(), ...rec });
  } catch { /* 记账不拖垮主流程 */ }
}
