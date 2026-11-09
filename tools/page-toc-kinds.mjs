// ============================================================================
// page-toc-kinds.mjs —— 知识页 TOC 的「三种页型」渲染器（2026-11-09 从 page-toc.mjs 按域拆出）
//
// 为什么单独一个文件：`tools/page-toc.mjs` 实测 221/230 行（96%）。
//   按 budgets.json 的 `_principle`「只许瘦不许胖：超限先按域拆分，别压缩行宽硬塞」处理。
//
// 分工：
//   · 本文件 = **纯函数**：把「一页的正文行」渲染成 TOC 块里那几行（按页型分三种）。
//     不认识文件、不写盘、不认识 argv —— 所以可被单测直接 import；
//   · `page-toc.mjs` = **CLI 入口**：argv 解析、去掉旧块、行号偏移探测、自校验、`.bak-<时间戳>` 备份、写盘。
//
// ⚠️ 契约（改这里会直接影响注入与 `cli tick` 的计数）：
//   ① 每个 `gen(lines, offset)` 必须返回 `{ out:string[], count:number, extra:number }`；
//   ② 输出的**每一行都以 `> ` 开头**（`test-toc.mjs` T2 断言「TOC 块每行以 > 开头」——
//      任何"跳过引用块"的解析器都不会误收）；
//   ③ 行号一律写成 `L${行号 + offset}`（offset = 块自身占的行数 + 2，由入口算好传进来）；
//   ④ 文案里的「条数/节数」不改措辞 —— 注入段与测试都在读它们。
// ============================================================================

/** 待办：分组 + 定时 + 行号（原 todo-toc 逻辑）。 */
const SCHED = /\[(at:[^\]]+|daily:[^\]]*|weekly:[^\]]*|\d{1,2}:\d{2})\]/i;

/** 教训每节列几条（多了会超过原来的注入段字数，2026-10-05 实测：全列 268 条 = 5842 字） */
const RECENT = 3;

const shorten = (s, max) => (s.length > max ? s.slice(0, max) : s);
const clean = (s) => String(s).replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

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

/** 页型 → 渲染器。`page-toc.mjs --kind <key>` 直接查这张表。 */
export const KINDS = { todo: tocTodo, lesson: tocLesson, fault: tocFault };
