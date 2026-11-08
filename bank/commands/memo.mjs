// memo —— 助手备忘录（2026-10-18 用户定名 + 定用法）
// ============================================================
// **为什么要有它**：我们实现了「遗忘衰减」（`dream`/`apply` 都会把久未使用的条目降权），
//   用户原话：「写了一个遗忘函数，现在基本一晚上你就会遗忘的差不多」⇒ 凡是**前一天商量完、还没动工**
//   的事，以及**还没提交的 bug**，先钉在这里；不然第二天我就不记得聊过。
//
// **它不是任务清单**（那是 todos.md），它是**记忆锚点**：
//   ① 每条带**原话时间戳**（用户说那句话的时刻，不是完成时刻）—— 忘了之后能对回去；
//   ② 做完**不删**，而是移到末尾并**极度精简**：「已完成 + 原话时间 + 几个字总结」（用户原话）。
//
// 结构固定两节：
//   `## 记着`   —— **三类都放这**：① 商量完还没动工的事 ② 还没提交的 bug ③ **想聊但没聊透的话题**
//                （用户 2026-10-18 举例：「比如 ai 的心理问题？」—— 这类最容易忘，因为它不是任务、没有触发点）
//   `## 已完成` —— 旧→新，只留一行一条。
// ⚠️ 本页在 `core.mjs` 的 `META_PAGES` 里 ⇒ 默认不参与召回（它是过程页，不是知识）。
// ============================================================
import path from 'node:path';
import { readText, writeText } from '../core.mjs';

const FILE = 'memo.md';
const TODO_HEAD = '## 记着';
const DONE_HEAD = '## 已完成';
const fileOf = (dir) => path.join(dir, 'pages', FILE);

/** 收尾整理（2026-10-18 实测：增删几次后会出现「条目之间空一行、标题被挤」）。 */
const tidy = (s) => String(s)
  .replace(/\n{3,}/g, '\n\n')
  .replace(/([^\n])\n(## )/g, '$1\n\n$2')
  .replace(/(## [^\n]+\n)\n+/g, '$1')
  .replace(/(\n- \[[ x]\] [^\n]*)\n+(?=- \[)/g, '$1\n');

/** 时间戳：`MM-DD HH:MM`（本地时间 —— 本页是给人看的，别用 UTC）。 */
export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 粗分节：返回 { head, todo: [...], done: [...] }（保留其它行不动，写回时按行重排）。 */
function parse(src) {
  const lines = String(src || '').split('\n');
  const iT = lines.findIndex((l) => l.trim() === TODO_HEAD);
  const iD = lines.findIndex((l) => l.trim() === DONE_HEAD);
  return { lines, iT, iD };
}

/** `cli memo list` —— 待办在前、已完成在后（各一行一条）。 */
export function listMemo(dir, log) {
  const src = readText(fileOf(dir));
  if (!src.trim()) { log('备忘录：空'); return; }
  const { lines, iT, iD } = parse(src);
  const grab = (from, to) => (from < 0 ? [] : lines.slice(from + 1, to < 0 ? lines.length : to).filter((l) => /^\s*- \[/.test(l)));
  const todo = grab(iT, iD);
  const done = grab(iD, -1);
  log(`备忘录：记着 ${todo.length} 条｜已完成 ${done.length} 条`);
  todo.forEach((t, i) => log(`  ${i + 1}. ${t.replace(/^\s*- \[ \]\s*/, '').slice(0, 120)}`));
  if (done.length) log('  ── 已完成（最近 5 条）──'), done.slice(-5).forEach((t) => log(`     ${t.replace(/^\s*- \[x\]\s*/, '').slice(0, 100)}`));
}

/** `cli memo add [--at "10-17 20:01"] "事项"` —— 钉进「## 待办」节末尾。 */
export function addMemo(dir, text, at) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, reason: '内容为空' };
  let src = readText(fileOf(dir));
  if (!src.trim()) src = `# memo（备忘录）\n\n${TODO_HEAD}\n\n${DONE_HEAD}\n`;
  const line = `- [ ] ${(at || stamp()).trim()} ${body}`;
  if (src.includes(body)) return { ok: false, reason: '已存在同内容的一条' };
  const { lines, iT, iD } = parse(src);
  if (iT < 0) return { ok: false, reason: '页面缺少「## 待办」节' };
  const at2 = iD < 0 ? lines.length : iD;
  lines.splice(at2, 0, line);
  writeText(fileOf(dir), tidy(lines.join('\n')));
  return { ok: true, line };
}

/**
 * `cli memo done <关键词> [总结]` —— **移到「## 已完成」末尾并压缩成一行**：
 *   `- [x] <原话时间> <总结>`（总结缺省就用原事项前 30 字）。
 */
export function doneMemo(dir, kw, summary) {
  const key = String(kw || '').trim();
  if (!key) return { ok: false, reason: '要一个关键词' };
  const { lines, iT, iD } = parse(readText(fileOf(dir)));
  const at = iD < 0 ? lines.length : iD;
  const idx = lines.findIndex((l, i) => i > iT && i < at && /^\s*- \[ \]/.test(l) && l.includes(key));
  if (idx < 0) return { ok: false, reason: '没有匹配的待办' };
  const raw = lines[idx].replace(/^\s*- \[ \]\s*/, '');
  const m = /^(\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s+(.*)$/.exec(raw);   // 允许「10-17」这种只有日期的时间戳
  const when = m ? m[1] : stamp();
  const what = String(summary || (m ? m[2] : raw)).trim().slice(0, 48);
  lines.splice(idx, 1);
  // 去掉末尾空行再追加 —— 否则「已完成」会一条隔一个空行（2026-10-18 实测）
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  lines.push(`- [x] ${when} ${what}`);
  writeText(fileOf(dir), tidy(lines.join('\n')));
  return { ok: true, when, what };
}

/** 开场注入一行；空待办返回 ''（不占预算）。只报**待办**，已完成不进注入。 */
export function formatMemoBrief(dir) {
  const { lines, iT, iD } = parse(readText(fileOf(dir)));
  const at = iD < 0 ? lines.length : iD;
  const todo = lines.slice(iT + 1, at).filter((l) => /^\s*- \[ \]/.test(l));
  if (!todo.length) return '';
  const first = todo[0].replace(/^\s*- \[ \]\s*/, '').slice(0, 50);
  return '【备忘录】记着 ' + todo.length + ' 件（最近：' + first + '）→ `cli memo list`。**你忘了也必须有据可查的地方**（待办 / 未提交的 bug / 想聊的话题，都带原话时间）。';
}
