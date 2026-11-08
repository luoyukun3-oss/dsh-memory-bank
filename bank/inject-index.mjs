// ============================================================================
// Memory Bank · 索引进注入的生成器（2026-10-05 从 bootstrap.mjs 按域拆出）
//   —— 三个零依赖纯函数：`tocInject`（TOC 块 + 定时条目）、`indexList`（待办逐条索引）、
//      `lessonIndex`（教训按节索引）。拆出的动因：bootstrap.mjs 被顶到 380/390 = 97%，
//      按「只许瘦不许胖：超限先按域拆分，别压缩行宽硬塞」的规矩处理，不靠删注释硬塞。
//   ⚠️ 本文件不许 import bank.mjs（会循环依赖）；目前只依赖 node 标准库。
// ============================================================================

/** 待办 TOC 注入（2026-10-05 用户定）：文件顶部有 TOC 块时，注入只出「目录 + 定时条目完整行」。
 *  非定时待办是给人看的（面板），只有定时条目需要 agent 到点执行 —— 实测 1618 → 约 540 字。
 *  没有 TOC 块则返回空串，由 indexList 回退到逐条逻辑（向后兼容）。 */
export function tocInject(src, maxLen) {
  const L = String(src || '').split(/\r?\n/);
  const b = L.findIndex((l) => /^>?\s*<!--\s*TOC:BEGIN/.test(l.trim()));
  const e = L.findIndex((l) => /^>?\s*<!--\s*TOC:END/.test(l.trim()));
  if (b < 0 || e <= b) return '';
  const toc = L.slice(b + 1, e).map((l) => l.trim().replace(/^> ?/, '')).filter(Boolean);
  const SCHED = /\[(at:[^\]]+|daily:[^\]]*|weekly:[^\]]*|\d{1,2}:\d{2})\]/i;
  const timed = [];
  for (const raw of L) {
    if (raw.trim().startsWith('>')) continue;
    const m = raw.match(/^\s*[-*]\s+\[([ xX])\]\s*(.+?)\s*$/);
    if (!m || m[1].toLowerCase() === 'x' || !SCHED.test(m[2])) continue;
    timed.push(m[2].length > maxLen ? m[2].slice(0, maxLen) + '…' : m[2]);
  }
  const head = '⏰ 定时条目（到点自动派发，故给完整原文）：';
  return toc.join('\n') + (timed.length ? '\n' + head + '\n' + timed.map((x) => '- ' + x).join('\n') : '');
}


// 索引式清单：待办每条压成一行（跳过已完成），按 ## 分节输出
export function indexList(text, { maxItems = 60, maxLen = 170, skipDone = true } = {}) {
  // TOC 优先：文件顶部有目录块时只出「目录 + 定时条目」；否则回退（下面那段逐条逻辑）。
  const toc = tocInject(text, maxLen);
  if (toc) return toc;
  const groups = new Map();
  let cur = '';
  for (const raw of String(text || '').split('\n')) {
    const h = raw.match(/^##+\s+(.+?)\s*$/);
    if (h) { cur = h[1]; continue; }
    const m = raw.match(/^\s*[-*]\s+\[([ xX])\]\s*(.+?)\s*$/);
    let done = false;
    let txt;
    if (m) {
      done = m[1].toLowerCase() === 'x';
      txt = m[2];
    } else {
      const bare = raw.match(/^\s*[-*]\s+(?!\[)(\S.*?)\s*$/);
      if (!bare) continue;
      txt = bare[1];
    }
    if (done && skipDone) continue;
    txt = String(txt).replace(/\s+/g, ' ').trim();
    // 跳过折叠标记、引用、空条目
    if (!txt || txt.startsWith('<') || txt.startsWith('>') || txt.startsWith('—')) continue;
    if (txt.length > maxLen) txt = txt.slice(0, maxLen) + '…';
    if (!groups.has(cur)) groups.set(cur, []);
    groups.get(cur).push(txt);
  }
  const out = [];
  let used = 0;
  for (const [sec, items] of groups) {
    if (used >= maxItems) break;
    const take = items.slice(0, maxItems - used);
    if (!take.length) continue;
    out.push((sec ? `## ${sec}\n` : '') + take.map((t) => `- ${t}`).join('\n'));
    used += take.length;
  }
  return out.join('\n');
}


/**
 * 教训索引·三层（2026-09-15 重做）：
 *   ① **大索引** = 每节的名字 + 条数（一眼看出有哪几类、哪类厚）
 *   ② **小索引** = 每节**最近 3 条**的要点（最近踩的坑最可能再踩）
 *   ③ **具体数据** = 不进注入，靠 `page lessons.md` 或 `recall "<关键词>"` 按需取
 *
 * 为什么要改：原先每节展开 14~15 条、共 **1749 字占注入 36%**，把总预算顶到 **4971/5000**，
 * 结果**新写的教训反而挤不进注入**（H 节末尾那条就没进去）—— 正是「写进说明 ≠ 从设计上堵住」的再现。
 * 改成取每节**最新的**若干条后，新教训一定进得去。
 * （保留原有标题抽取逻辑：日期式条目先剥日期、加粗片段过短退回整条 —— 都是踩过的坑。）
 */



export function lessonIndex(text, { maxLen = 40, recent = 3 } = {}) {
  // TOC 优先（2026-10-05）：lessons.md 顶部有 page-toc.mjs 生成的目录块时直接用它
  // —— 每节带条数 + 最近几条 + **正文行号**，实测 1306 → 852 字，且可按行号直接 read。
  const toc = tocInject(String(text || ''), maxLen);
  if (toc) return toc;
  const groups = [];
  let cur = '';
  for (const raw of String(text || '').split('\n')) {
    const h = raw.match(/^##+\s+(.+?)\s*$/);
    if (h) {
      // 节标题去掉括号里的说明，省字数
      cur = h[1].replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
      continue;
    }
    // 只认**顶层**条目（不缩进）：缩进的是某条的续行/子项，混进来会让「最近 3 条」取到
    // 没有父标题的子项（实测 E 节因此被数成 35 条，且最近 3 条全是子条目，读起来没头没尾）
    const m = raw.match(/^[-*]\s+(?!\[)(\S.*?)\s*$/);
    if (!m) continue;
    let src = m[1];
    // 日期式条目（`**2026-09-15**：xxx`）：先剥掉日期，再取第一个分句当标题
    // —— 否则标题会退化成"2026-09-15"，完全看不出内容（H 节踩过）
    const isDateLead = /^\*\*\d{4}[-\/]\d{1,2}([-\/]\d{1,2})?\*\*/.test(src);
    if (isDateLead) {
      src = src.replace(/^\*\*\d{4}[-\/]\d{1,2}([-\/]\d{1,2})?\*\*\s*[:：]?\s*/, '');
      src = src.split(/——|：|，|。|;/)[0].trim();
    }
    const bold = src.match(/\*\*(.+?)\*\*/);
    const boldText = bold ? bold[1].replace(/[`*_]/g, '').trim() : '';
    // 加粗片段太短（"结论"「沙箱内」这种）脱离上下文看不懂 → 退回整条再截断
    let title = (isDateLead || boldText.length < 6 ? src : bold[1])
      .replace(/^⚠️\s*/, '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
    if (title.length < 2) continue;
    if (title.length > maxLen) title = title.slice(0, maxLen) + '…';
    let g = groups[groups.length - 1];
    if (!g || g.sec !== cur) { g = { sec: cur, items: [] }; groups.push(g); }
    g.items.push(title);
  }
  const kept = groups.filter((g) => g.items.length);
  const total = kept.reduce((n, g) => n + g.items.length, 0);
  const body = kept
    .map((g) => `- **${g.sec}**（${g.items.length} 条）· 最近：${g.items.slice(-recent).join('｜')}`)
    .join('\n');
  return `共 ${kept.length} 类 · ${total} 条｜这里只列每类最近 ${recent} 条，全量用 \`page lessons.md\`，相关的用 \`recall "<关键词>"\`\n${body}`;
}
