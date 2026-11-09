// ============================================================================
// Memory Bank · extract-parse —— 「模型那段文字 → 结构化候选」（2026-11-09 从 extract.mjs 按域拆出）
//
// 为什么拆：同 extract-prompt.mjs（350/360 逼近红线 ⇒ 按域拆，不压缩行宽）。
//   这一域只做一件事：把模型输出解析成候选数组。纯函数、不发请求。
//   护栏口径（条数 / 单条字数）一律来自 extract-prompt.mjs 的 LIMITS，**不另写一套**。
// ============================================================================
import { clip } from './core.mjs';                      // 单条字数截断（与 prompt 侧同一把尺）
import { LIMITS, str } from './extract-prompt.mjs';

const KINDS = new Set(['preferences', 'todos', 'environment', 'lessons']);

/** 从模型输出里抠 JSON 数组：先剥 ```json 围栏，再整体 parse，最后退一步找最外层方括号 */
export function parseExtractResponse(raw, { maxCandidates = LIMITS.maxCandidates } = {}) {
  let s = str(raw);
  if (!s) return { ok: false, reason: '空响应', candidates: [] };
  if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  let arr = null;
  try {
    const v = JSON.parse(s);
    arr = Array.isArray(v) ? v : (v && Array.isArray(v.candidates) ? v.candidates : null);
  } catch { /* 落到正则兜底 */ }
  if (!arr) {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a !== -1 && b > a) { try { const v = JSON.parse(s.slice(a, b + 1)); arr = Array.isArray(v) ? v : null; } catch { /* 仍失败 */ } }
  }
  if (!arr) return { ok: false, reason: '输出不是 JSON 数组（已尝试剥围栏/取最外层方括号）', candidates: [] };
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const kind = str(it.kind).toLowerCase().replace(/\.md$/, '');
    const text = clip(str(it.text), LIMITS.maxTextChars);
    const why = clip(str(it.why), LIMITS.maxWhyChars);
    if (!KINDS.has(kind) || !text) continue;
    out.push({ kind, text, why });
    if (out.length >= maxCandidates) break;
  }
  // ⚠️ dropped 只能算一次：`arr.length - out.length` 同时覆盖「非法元素」与「超出 maxCandidates」
  //    （第一版写成 `bad + (arr.length - out.length)`，把两者重复计了一遍 —— test-extract 抓到过）
  return { ok: true, candidates: out, dropped: arr.length - out.length };
}
