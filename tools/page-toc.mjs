#!/usr/bin/env node
// ============================================================================
// page-toc.mjs —— 给记忆银行的知识页生成/刷新顶部「精准目录」（TOC）块
//
// 为什么：注入里不再逐条铺开内容，只留顶部这份目录（带正文行号）+ 少量必须完整的条目。
// 目录块每行以 "> " 开头 ⇒ 面板（dsh-todo-panel）与旧解析规则都会自动跳过，零副作用。
//
// 用法：
//   node page-toc.mjs --kind todo   --file <todos.md>      待办（分组 + 定时 + 行号）
//   node page-toc.mjs --kind lesson --file <lessons.md>    教训（按 ## 分节，全部条目要点 + 行号）
//   node page-toc.mjs --kind fault  --file <faults.md>     故障（表格：症状 + i 值 + 行号）
//   node page-toc.mjs --all --repo <repoDir>               一次刷三页（tick 用）
//   node page-toc.mjs --check …                            只报告是否过期
//
// 结构固定：`# 标题` + 空行 + [块] + 空行 + 原正文 ⇒ 行号偏移恒为「块行数 + 2」，且幂等。
// 兼容旧名：todo-toc.mjs 的调用方式（--kind 省略时按 todo 处理）保持不变。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const CHECK = argv.includes('--check');
const ALL = argv.includes('--all');
const REPO = opt('--repo');

const BEGIN_LINE = '<!-- TOC:BEGIN —— 自动生成（_dsh_memory/tools/page-toc.mjs），勿手改 -->';
const END_LINE = '<!-- TOC:END -->';
const BEGIN_RE = /^<!--\s*TOC:BEGIN[\s\S]*?-->\s*$/;
const END_RE = /^<!--\s*TOC:END\s*-->\s*$/;
const SCHED = /\[(at:[^\]]+|daily:[^\]]*|weekly:[^\]]*|\d{1,2}:\d{2})\]/i;

/** 教训每节列几条（多了会超过原来的注入段字数，2026-10-05 实测：全列 268 条 = 5842 字） */
const RECENT = 3;

const shorten = (s, max) => (s.length > max ? s.slice(0, max) : s);
const clean = (s) => String(s).replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

/** 待办：分组 + 定时 + 行号（原 todo-toc 逻辑）。 */
function tocTodo(lines, offset) {
  const sections = [];
  let cur = null;
  lines.forEach((raw, i) => {
    const text = raw.trim();
    if (text.startsWith('>')) return;
    const h = /^##+\s+(.+?)\s*$/.exec(text);
    if (h) { cur = { title: h[1], items: [] }; sections.push(cur); return; }
    const m = /^\s*[-*]\s+\[([ xX])\]\s*(.+?)\s*$/.exec(raw);
    let body = null, done = false;
    if (m) { done = m[1].toLowerCase() === 'x'; body = m[2]; }
    else {
      const bare = /^\s*[-*]\s+(?!\[)(\S.*?)\s*$/.exec(raw);
      if (!bare) return;
      body = bare[1];
    }
    if (done || body.startsWith('<')) return;
    if (!cur) { cur = { title: '(未分组)', items: [] }; sections.push(cur); }
    let title = body, detail = '';
    const b = /^\*\*(.+?)\*\*\s*[：:]?\s*([\s\S]*)$/.exec(body);
    if (b) { title = b[1].trim(); detail = b[2].trim(); }
    const sc = SCHED.exec(title + ' ' + detail);
    cur.items.push({
      title: clean(title.replace(new RegExp(SCHED.source, 'gi'), '')),
      sched: sc ? sc[1] : null, line: i + 1,
    });
  });
  const kept = sections.filter((s) => s.items.length);
  const all = kept.flatMap((s) => s.items);
  const timed = all.filter((it) => it.sched);
  const short = (it) => {
    let t = it.title;
    const br = /【(.+?)】/.exec(t);
    if (br) t = br[1];
    return shorten(clean(t.replace(/^\d{4}-\d{2}-\d{2}\s*/, '').replace(/[（(][^（()）]*[)）]/g, '')), 18);
  };
  const out = [`> **待办 ${all.length} 条** ｜ ` + kept.map((s) => `${s.title} ${s.items.length}`).join(' ｜ ')];
  if (timed.length) {
    out.push('> ⏰ 定时：' + timed.map((it) => `${/^at:/i.test(it.sched) ? it.sched.slice(3) : it.sched} ${short(it)}`).join(' ｜ ') + '（到点自动派发，正文见下）');
  }
  for (const s of kept) out.push('> · ' + s.title + '：' + s.items.map((it) => `${short(it)} L${it.line + offset}`).join(' · '));
  return { out, count: all.length, extra: timed.length };
}

/** 教训：按 ## 分节，列**全部**顶层条目要点 + 行号（原实现每节只给最近 3 条）。 */
function tocLesson(lines, offset) {
  const groups = [];
  let cur = null;
  lines.forEach((raw, i) => {
    const text = raw.trim();
    if (text.startsWith('>')) return;
    const h = /^##+\s+(.+?)\s*$/.exec(text);
    if (h) { cur = { title: clean(h[1].replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '')), items: [] }; groups.push(cur); return; }
    const m = /^[-*]\s+(?!\[)(\S.*?)\s*$/.exec(raw);   // 只认顶层条目（缩进是续行）
    if (!m || !cur) return;
    let src = m[1];
    const isDateLead = /^\*\*\d{4}[-\/]\d{1,2}([-\/]\d{1,2})?\*\*/.test(src);
    if (isDateLead) src = src.replace(/^\*\*\d{4}[-\/]\d{1,2}([-\/]\d{1,2})?\*\*\s*[:：]?\s*/, '');
    const bold = src.match(/\*\*(.+?)\*\*/);
    const boldText = bold ? clean(bold[1]) : '';
    let title = (isDateLead || boldText.length < 6 ? src.split(/——|：|，|。|;/)[0] : boldText);
    title = clean(title.replace(/^⚠️\s*/, ''));
    if (title.length < 2) return;
    // 2026-10-29：条目带日期，「取最新 3 条」才不依赖文件顺序 ——
    //   lessons.md 的 H 节是**最新在最上**（prepend），其它节是最新在下（append）。
    //   原来 `slice(-3)` 在 H 节取到的是**最旧**的 3 条 ⇒ 新写的教训一条也进不了注入。
    const dm = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/.exec(src);
    const date = dm ? `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}` : '';
    cur.items.push({ title: shorten(title, 20), line: i + 1, date });
  });
  const kept = groups.filter((g) => g.items.length);
  const total = kept.reduce((n, g) => n + g.items.length, 0);
  const out = [`> **教训 ${kept.length} 节 / ${total} 条**（每节列最近 ${RECENT} 条；细节按行号 read 或 recall）`];
  for (const g of kept) {
    // 2026-10-29：**先探测这一节的日期方向**，再决定取头还是取尾。
    //   lessons.md 的 H 节是「最新在最上」（prepend：首条日期 > 末条），其余节是「最新在最下」。
    //   原来一律 `slice(-3)` ⇒ H 节永远只列最旧 3 条，新写的教训一条也进不了注入。
    //   探测而不是硬编节名：判据来自数据本身，将来哪一节改写法也自动跟得上。
    const firstD = g.items[0].date;
    const lastD = g.items[g.items.length - 1].date;
    const newestOnTop = !!(firstD && lastD && firstD > lastD);
    // 统一按「旧的在前、新的在后」展示，和原来 A~G 节的样子保持一致
    const picked = newestOnTop ? g.items.slice(0, RECENT).reverse() : g.items.slice(-RECENT);
    const tail = picked.map((it) => `${it.title} L${it.line + offset}`).join(' · ');
    const rest = g.items.length - Math.min(RECENT, g.items.length);
    out.push('> · ' + g.title + `（${g.items.length}${rest > 0 ? `，另有 ${rest} 条` : ''}）：` + tail);
  }
  return { out, count: total, extra: kept.length };
}

/** 故障：表格形态，取「症状」列 + i 值 + 行号。 */
function tocFault(lines, offset) {
  const sepIdx = lines.findIndex((l) => /^\s*\|[\s:|-]+\|\s*$/.test(l));
  const rows = [];
  if (sepIdx >= 0) {
    lines.forEach((raw, i) => {
      if (i <= sepIdx) return;
      if (!/^\s*\|/.test(raw)) return;
      const cells = raw.split('|');
      if (cells.length < 3) return;
      const sym = clean(cells[1]);
      if (!sym) return;
      const im = /\bi\s*[:：]\s*(\d)/.exec(raw);
      rows.push({ sym: shorten(sym, 26), i: im ? Number(im[1]) : 3, line: i + 1 });
    });
  }
  const hi = rows.filter((r) => r.i >= 4);
  const out = [`> **故障 ${rows.length} 条**（注入只列 i≥4 的 ${hi.length} 条、且只给「症状 ｜ 先查这里」；其余按需 recall）`];
  const sorted = rows.slice().sort((a, b) => b.i - a.i || a.line - b.line);
  for (const r of sorted) out.push(`> · i${r.i} ${r.sym} L${r.line + offset}`);
  return { out, count: rows.length, extra: hi.length };
}

const KINDS = { todo: tocTodo, lesson: tocLesson, fault: tocFault };

/** 生成 + 写入一页；返回一句状态。 */
function refresh(kind, file) {
  const gen = KINDS[kind];
  if (!gen) return `${file}: 未知 kind`;
  if (!fs.existsSync(file)) return `${path.basename(file)}: 文件不存在，跳过`;
  const src = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = src.split('\n');

  // 去掉旧块（连同紧邻空行）⇒ 干净正文
  let cleanLines = lines.slice();
  // ⚠️ 循环删**所有** TOC 块：曾经只删第一对 ⇒ 文件中残留的第二对会在刷新后继续存在
  //    （实测 2026-10-05：todos.md 里同时有旧格式块与新格式块，目录出现两套互相矛盾的快照）。
  for (;;) {
    const bi = cleanLines.findIndex((l) => BEGIN_RE.test(l.trim()));
    const ei = cleanLines.findIndex((l) => END_RE.test(l.trim()));
    if (bi < 0 || ei <= bi) break;
    let from = bi, to = ei;
    if (cleanLines[from - 1] !== undefined && cleanLines[from - 1].trim() === '') from -= 1;
    if (cleanLines[to + 1] !== undefined && cleanLines[to + 1].trim() === '') to += 1;
    cleanLines = cleanLines.slice(0, from).concat(cleanLines.slice(to + 1));
  }
  const h1 = cleanLines.findIndex((l) => /^#\s+/.test(l.trim()));
  const at = h1 >= 0 ? h1 + 1 : 0;
  const assemble = (block) => cleanLines.slice(0, at).concat([''], block, [''], cleanLines.slice(at)).join('\n');

  const probe = [BEGIN_LINE, ...gen(cleanLines, 0).out, END_LINE];
  const offset = probe.length + 2;
  const block = [BEGIN_LINE, ...gen(cleanLines, offset).out, END_LINE];
  const newText = assemble(block);

  // 自校验：用已插入块的新文本再解析一次，行号应为真实行号（偏移 0）⇒ 两份目录须逐字一致
  const actual = gen(newText.split('\n'), 0).out.join('\n');
  const written = gen(cleanLines, offset).out.join('\n');
  if (actual !== written) {
    const A = actual.split('\n'), W = written.split('\n');
    const diff = [];
    for (let i = 0; i < Math.max(A.length, W.length) && diff.length < 3; i++) {
      if (A[i] !== W[i]) diff.push(`      第 ${i + 1} 行 期望[${String(W[i]).slice(0, 60)}] 实得[${String(A[i]).slice(0, 60)}]`);
    }
    return `${path.basename(file)}: ⚠️ 自校验失败（行号不稳），未写入\n` + diff.join('\n');
  }

  if (CHECK) return `${path.basename(file)}: ${newText === src ? '最新' : '已过期'}`;
  if (newText === src) return `${path.basename(file)}: 无需改动`;

  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  fs.writeFileSync(`${file}.bak-${stamp}`, src, 'utf8');
  fs.writeFileSync(file, newText, 'utf8');
  const stat = gen(cleanLines, 0);
  return `${path.basename(file)}: 已刷新（${stat.count} 条，块 ${block.length} 行，目录 ${written.replace(/\s/g, '').length} 字）`;
}

// ---- 入口 ----
const targets = [];
if (ALL || REPO) {
  const repo = REPO || 'E:/2/_dsh_memory/repos/e-2';
  targets.push(['todo', path.join(repo, 'pages', 'todos.md')]);
  targets.push(['lesson', path.join(repo, 'pages', 'lessons.md')]);
  targets.push(['fault', path.join(repo, 'pages', 'faults.md')]);
} else {
  const kind = opt('--kind') || 'todo';
  const file = opt('--file') || 'E:/2/_dsh_memory/repos/e-2/pages/todos.md';
  targets.push([kind, file]);
}
for (const [kind, file] of targets) console.log('  ' + refresh(kind, file));
