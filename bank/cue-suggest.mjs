// Memory Bank · cue 候选词建议（2026-10-23）—— 治「新写的教训又长回哑弹」。
//
// 背景：2026-10-15 那条教训说得很清楚 ——「写进教训页 ≠ 会被触发」，因为 `cue.mjs` 是**词表驱动**
// （只认条目里的 `<!-- cue:... -->`），正文写得再细也不会被抽成触发词。10-23 一次性给 385 条补了词
// （子代理做的），但**从那天起新 `remember` 的条目还是会哑**。本模块就是那一环的「提醒」。
//
// ⚠️ 它是**只建议、不写入**：cue 档刻意绕过召回分数门（见 cue.mjs 头注释），自动写错词的代价是
//    每轮注入脏内容 ⇒ 由调用方（人/agent）过一眼再补，比自动写好。
// ⚠️ 判定全部复用 cue.mjs 的 `cueWordOk`（长度/停用词/字符白名单），不另立一套 —— 两套判据必然漂移。
import { cueWordOk } from './cue.mjs';

/** 语言关键字与内置名：它们在任何代码里都出现，当触发词等于每轮都触发（2026-10-23 原型实测抽到过 if/None/d1）。
 *  只放「单独出现毫无辨识度」的；`KeyError`/`TimeoutError` 这类具体报错名**不在**表里，那正是好词。 */
const KEYWORDS = new Set([
  'if', 'elif', 'else', 'for', 'while', 'def', 'class', 'return', 'yield', 'break', 'continue', 'pass',
  'try', 'except', 'finally', 'with', 'as', 'lambda', 'global', 'nonlocal', 'assert', 'del', 'import', 'from',
  'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'self', 'cls',
  'print', 'len', 'int', 'str', 'float', 'list', 'dict', 'set', 'tuple', 'range', 'open', 'type', 'input',
  'super', 'id', 'map', 'filter', 'zip', 'sum', 'min', 'max', 'abs', 'round', 'sorted', 'enumerate', 'format',
  'items', 'keys', 'values', 'append', 'join', 'split', 'strip', 'replace', 'get', 'line', 'text',
]);

/** 看起来像「标识符」的词优先：含 `.`/`_`/大写字母/括号 —— 比中文短语更不容易误触发。 */
const looksIdent = (w) => /[._]/.test(w) || /[A-Z]/.test(w) || /\(\)/.test(w);

/**
 * 从一段正文里挑「看到就会想起它」的触发词候选。
 * @param {string} text   条目正文
 * @param {Array}  docs   index.json 的 docs（用来算 df，即「库内常见度」）
 * @param {{limit?:number, dfMax?:number}} opts
 * @returns {string[]} 建议词；调用方决定要不要写进 `<!-- cue:... -->`
 */
export function suggestCues(text, docs, { limit = 3, dfMax = 0.08 } = {}) {
  const t = String(text || '');
  if (!t.trim()) return [];
  // 抽取源：反引号片段（代码/报错原文） + 英文/驼峰标识符
  const backs = [...t.matchAll(/`([^`\n]{2,40})`/g)].map((m) => m[1].trim());
  const eng = [...t.matchAll(/\b([A-Z][A-Za-z]{2,}|[a-z]{2,}[A-Z][A-Za-z]*|[a-z]{3,}\.[a-z]{2,})\b/g)].map((m) => m[1]);
  const cands = [...new Set([...backs, ...eng])];
  if (!cands.length) return [];
  // df：库里有多少条目提到它（中文走 bigram token，长词走子串）
  const list = (docs || []).filter((d) => d && d.kind === 'page');
  const tokenSets = list.map((d) => new Set(d.tokens || []));
  const full = list.map((d) => ((d.title || '') + '\n' + (d.text || '')).toLowerCase());
  const N = list.length || 1;
  const df = (w) => {
    const lw = String(w).toLowerCase();
    return lw.length <= 2
      ? tokenSets.reduce((n, s) => n + (s.has(lw) ? 1 : 0), 0)
      : full.reduce((n, x) => n + (x.includes(lw) ? 1 : 0), 0);
  };
  const scored = [];
  for (const w of cands) {
    const spaced = w.replace(/\+/g, ' ').trim();
    const low = spaced.toLowerCase();
    if (KEYWORDS.has(low)) continue;
    if (/^[a-z]\d{0,2}$/.test(low)) continue;             // 示例变量名 d1 / b1 / a2
    if (!cueWordOk(spaced, { allowSpace: true, maxLen: 40 })) continue;
    const ratio = df(spaced) / N;
    // 纯 ASCII 词（英文/标识符）用**更严**的门：实测 `PowerShell` 这种在库里只占 ~6%，过得了 8% 的场，
    // 但它是货真价实的泛词（每条 PowerShell 相关的提问都会命中）⇒ 英文档压到 3%。中文词保持 8%。
    const cap = /^[\x20-\x7F]+$/.test(spaced) ? 0.03 : dfMax;
    if (ratio > cap) continue;                            // 库里太常见的不当触发词
    scored.push({ w: spaced, score: (looksIdent(spaced) ? 2 : 1) * 10 - ratio * 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.w);
}
