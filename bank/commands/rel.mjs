// ============================================================================
// commands/rel.mjs —— `cli rel` 关系编辑入口（2026-11-09）
//
// 起因：主人要「看着他记忆里的联系，还能直接手动连」。此前手改一条 rel 边必须去记
//   `tools/` 下 4 个脚本的参数（rel-apply 走 verdicts.json 批量 / rel-type 只补类型 /
//   rel-fix / rel-rewrite），**没有「顺手连一条」的入口**。
//
// ⚠️ rel 边的真实格式（**以 core.mjs 的 parseMeta 为准，别信转述**）：
//     <!-- rel:<页.md>:<关键词>[:<类型>] -->
//   多值用**逗号**分隔、**整条只有一个 `rel:` 前缀**。真实样例：
//     <!-- rel:lessons.md:**数字输入容错范式**（闰年那题演化出:scenario -->
//     <!-- rel:faults.md:正文末尾多了个页名 -->
//   四条硬规则（每条都对应一个静默失败）：
//     ① 页名必须匹配 `[\w.-]+\.md`（parseMeta 的正则），否则整条边被静默丢弃；
//     ② 类型取**末段**且必须在 `REL_TYPES` 白名单里 —— 关键词本身可能含冒号，所以不能按段数切；
//     ③ 关键词**不能含空白**（注释按 `\s+` 切分 ⇒ 含空格会被切碎、边指错/指空）、
//        不能含 `,`（多值分隔符）或 `:`（类型分隔符）；
//     ④ 关键词必须能**唯一定位**目标条目 —— `search.mjs`/`assoc.mjs` 用的是
//        `title/text.includes(key)` 取**第一个**匹配，不唯一就会静默指到别的条目上。
//        （rel-apply.mjs 的三条硬教训，2026-10-13 建 40 条边时踩出来的，全部无报错。）
//
// 复用现状：`tools/rel-apply.mjs` 的「安全改写页面注释」逻辑**是顶层脚本、无 export**
//   （文件头就跑 verdicts.json），没法 import 复用；且它只支持「加」、不支持「删」。
//   所以这里重写了同一套三形态写入，并抽成纯函数 `applyRelOp()` 供测试直接打
//   —— 差异与理由见该函数注释。**没有改 rel-apply.mjs**：它是在用的批量工具，动它风险 > 这段重复的成本。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVED_PAGES, REL_TYPES, parseMeta, readJson, readText, writeText } from '../core.mjs';
import { listItems } from '../bank.mjs';

const USAGE = '用法：cli rel list [--page <页>] [--json] ｜ '
  + 'cli rel add "<源页>:<关键词>" <类型> "<目标页>:<关键词>" [--both] [--apply] ｜ '
  + 'cli rel rm "<源页>:<关键词>" [<类型>|-] "<目标页>:<关键词>" [--both] [--apply]';

const short = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** `"页.md:关键词"` → `{ page, kw }`；格式错返回 null（调用方给明确报错，绝不静默）。 */
export function parseRef(ref) {
  const s = String(ref || '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const page = s.slice(0, i).trim();
  const kw = s.slice(i + 1).trim();
  if (!/^[\w.-]+\.md$/.test(page) || !kw) return null;
  return { page, kw };
}

/** 关键词能不能安全写进 `rel:`（规则 ③）。返回 null = 可以，否则返回原因。 */
export function keyProblem(kw) {
  if (/\s/.test(kw)) return '含空白（注释按空白切分 ⇒ 会被切碎，边指错/指空）';
  if (kw.includes(',')) return '含逗号（那是多值分隔符）';
  if (kw.includes(':')) return '含冒号（那是类型分隔符）';
  if (kw.length < 2) return '太短（<2 字，无法唯一定位）';
  return null;
}

/**
 * 在条目池里按「页 + 关键词」定位，**要求唯一命中**（规则 ④）。
 * ⚠️ 匹配必须用**剥掉元数据注释后**的正文（`parseMeta(raw).cleaned`），不能用 `raw` ——
 *   2026-11-09 实测踩到：`raw` 含注释，于是「A → rel:页:B」这一行里也出现了 `B`，
 *   搜 B 会**假命中**两条（目标条目自己 + 指向它的那条边），add/rm 直接报「不唯一」而不可用。
 *   索引端的 `d.text` 也是剥注释的 ⇒ 这里与检索端同语义。
 * 返回 `{ hit }` 或 `{ error, candidates }` —— 多命中时把候选交给调用方打印。
 */
export function locate(items, { page, kw }) {
  const inPage = items.filter((it) => it.page === page);
  if (!inPage.length) return { error: `页 ${page} 不存在或没有条目` };
  const hits = inPage.filter((it) => parseMeta(it.raw).cleaned.includes(kw));
  if (!hits.length) {
    const near = inPage.map((it) => `  ${it.page}:${it.line}  ${short(it.title, 50)}`).join('\n');
    return { error: `在 ${page} 里找不到含「${kw}」的条目`, candidates: near };
  }
  if (hits.length > 1) {
    return {
      error: `关键词「${kw}」命中 ${hits.length} 条，不唯一（检索端取第一个匹配，会静默指错）—— 换个更长的词`,
      candidates: hits.map((it) => `  ${it.page}:${it.line}  ${short(it.title, 50)}`).join('\n'),
    };
  }
  return { hit: hits[0] };
}

/**
 * 把一条 `rel:` 边**加进/删出**某一行（纯函数，不碰文件 —— 便于测试直接打）。
 *
 * 为什么重写而不 import `tools/rel-apply.mjs`：那个工具是**顶层脚本**（文件头就读
 *   verdicts.json 并 process.exit），没有任何 export；而且它只处理「加」。
 *   这里的三形态（无注释 / 有别的元数据 / 已有 rel）与它**逐字同源**（它的 L105-114），
 *   额外多一个 `rm` 分支和「删空后清理整条 rel 键」。
 *
 * @param {string} line 条目首行原文
 * @param {{val?: string, op?: 'add'|'rm'}} o `val` 形如 `rel:页:关键词[:类型]`
 * @returns {{line: string, changed: boolean, why?: string}}
 */
export function applyRelOp(line, { val = '', op = 'add' } = {}) {
  const body = String(val).replace(/^rel:/, '');
  const blockM = line.match(/<!--([\s\S]*?)-->/);
  const block = blockM ? blockM[0] : '';
  const relM = block.match(/(\brel:)([^\s]*)/);
  if (op === 'add') {
    if (relM) {
      const list = relM[2].split(',').filter(Boolean);
      if (list.includes(body)) return { line, changed: false, why: '这条边已存在（幂等，不重复写）' };
      return { line: line.replace(relM[0], `${relM[1]}${relM[2]},${body}`), changed: true };
    }
    if (!blockM) return { line: `${line.trimEnd()} <!-- rel:${body} -->`, changed: true };   // 形态①
    const inner = blockM[1].trim();
    return {                                                                                  // 形态②
      line: line.replace(block, `<!-- ${inner ? `${inner} ` : ''}rel:${body} -->`),
      changed: true,
    };
  }
  // —— rm ——
  if (!relM) return { line, changed: false, why: '该行没有 rel 边' };
  const list = relM[2].split(',').filter(Boolean);
  const keep = list.filter((x) => x !== body);
  if (keep.length === list.length) return { line, changed: false, why: `该行没有这条边（现有：${list.join(' , ')}）` };
  if (keep.length) {
    return { line: line.replace(relM[0], `${relM[1]}${keep.join(',')}`), changed: true };
  }
  // 删空了：把整条 `rel:` 连注释内多余空白一起去掉；注释若因此变空，连注释块一起删
  const leftover = block.replace(relM[0], '').replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim();
  return leftover
    ? { line: line.replace(block, `<!-- ${leftover} -->`), changed: true }
    : { line: line.replace(block, '').trimEnd(), changed: true };
}

/** 读某一页的行数组（BOM 保留在首字符里，写回时原样带回去）。 */
function readLines(dir, page) {
  const text = readText(path.join(dir, 'pages', page));
  if (!text) return null;
  return text.split('\n');
}

/** 备份 + 原子写（`writeText` = 同目录 tmp + rename，见 core.mjs 头注释）。 */
function savePage(dir, page, lines, ts) {
  const f = path.join(dir, 'pages', page);
  const bak = `${f}.bak-rel-${ts}`;
  fs.copyFileSync(f, bak);
  writeText(f, lines.join('\n'));
  return bak;
}

/**
 * 逐行扫页面里的所有 `rel:` 边。
 * ⚠️ **不用 `listItems` 枚举边**（2026-11-09 实测踩到）：`listItems` 走 `pageBlocks`（**按行**切条目），
 *   而索引对非 `ITEM_PAGES` 页（如 `index-files.md`）是**按 `##` 节**切（`index-rebuild.mjs:45`）——
 *   两者切法不同 ⇒ 拿 listItems 判「目标在不在」会出**假阳性坏边**（实测 `index-files.md` 有 42 个
 *   pageBlocks 条目、索引里只有 7 个 doc）。逐行扫 `rel:` 则与切分规则无关，不漏也不误判。
 */
function scanEdges(dir, only) {
  const pagesDir = path.join(dir, 'pages');
  const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  const out = [];
  for (const f of files) {
    if (only && f !== only) continue;
    const lines = readText(path.join(pagesDir, f)).split('\n');
    lines.forEach((l, i) => {
      const blockM = l.match(/<!--([\s\S]*?)-->/);
      if (!blockM || !/\brel:/.test(blockM[1])) return;
      for (const r of parseMeta(blockM[0]).meta.rel || []) out.push({ page: f, line: i + 1, r });
    });
  }
  return out;
}

/**
 * 目标可达性四态（判据 = **检索端真相**：`index.json` 的 docs + `title/text.includes`，
 * 与 `search.mjs` / `assoc.mjs` 的 findRel、以及 `test-rel.mjs` 的三条守护**同一判据**）：
 *   `ok`        索引里命中 1 条            → 边有效
 *   `ambiguous` 索引里命中 >1 条           → 指向不确定（`search.mjs` 静默取第一条）
 *   `stale`     页面条目里能、索引里不能    → 多半是改完没 reindex，不是真坏
 *   `missing`   两边都定位不到             → **真坏边**（检索端必然静默丢弃）
 */
function targetState(docs, items, r) {
  const hits = docs.filter((d) => d.page === r.page
    && ((d.title || '').includes(r.key) || (d.text || '').includes(r.key)));
  if (hits.length > 1) return { state: 'ambiguous', where: `命中 ${hits.length} 条：${hits.slice(0, 3).map((h) => h.id).join(' / ')}` };
  if (hits.length === 1) return { state: 'ok', where: hits[0].id };
  const inPage = items.find((it) => it.page === r.page && parseMeta(it.raw).cleaned.includes(r.key));
  return inPage
    ? { state: 'stale', where: `${inPage.page}:${inPage.line}` }
    : { state: 'missing', where: null };
}

/**
 * `rm` 用：在源条目的现有 `rel:` 里，按**目标条目身份（docs id）**找回那条边的**原始字面**。
 * 为什么不能直接用用户输入的词：写入时的 key 是建边工具从 title 截断出来的原文（可能带 `**`、
 * 半截括号），用户不可能逐字复述 ⇒ 按字面匹配会让 `rm` 永远删不掉（2026-11-09 实测踩到）。
 */
function pickExistingEdge(srcItem, dstPage, dstId, docs, wantType) {
  if (!dstId) return null;
  for (const r of parseMeta(srcItem.raw).meta.rel || []) {
    if (wantType && r.type !== wantType) continue;
    if (r.page !== dstPage) continue;
    const cand = docs.find((d) => d.page === r.page
      && ((d.title || '').includes(r.key) || (d.text || '').includes(r.key)));
    if (cand && cand.id === dstId) return `${r.page}:${r.key}${r.type ? `:${r.type}` : ''}`;
  }
  return null;
}

/** `rel list`：列出全部边 + 标出**目标不可达**的边（区分「真坏」与「索引滞后」）。 */
function cmdList({ items, docs, opt, log, dir }) {
  const only = typeof opt('page') === 'string' ? String(opt('page')) : null;
  const edges = scanEdges(dir, only);
  const rows = edges.map((e) => ({ ...e, t: targetState(docs, items, e.r) }));
  const bad = rows.filter((x) => x.t.state === 'missing');
  const stale = rows.filter((x) => x.t.state === 'stale');
  const amb = rows.filter((x) => x.t.state === 'ambiguous');
  const typed = rows.filter((x) => x.r.type).length;
  if (opt('json')) {
    log(JSON.stringify({
      total: rows.length, typed, bad: bad.length, stale: stale.length, ambiguous: amb.length,
      edges: rows.map((x) => ({ src: x.page, line: x.line, type: x.r.type, page: x.r.page, key: x.r.key, state: x.t.state })),
    }, null, 2));
    return;
  }
  log(`rel 边：共 **${rows.length}** 条（带类型 ${typed} / 无类型 ${rows.length - typed}）${only ? `（仅 ${only}）` : ''}`
    + `｜坏边 **${bad.length}** 条${bad.length ? ' ⚠️' : ' ✅'}`
    + `${amb.length ? `｜指向不确定 ${amb.length} 条` : ''}${stale.length ? `｜索引滞后 ${stale.length} 条` : ''}`);
  if (!rows.length) { log(`\n${only ? `页 ${only} 里` : '全库'}没有任何 rel 边。`); return; }
  log('');
  log('| 源（页:行） | 类型 | 目标页 | 关键词 | 状态 |');
  log('|---|---|---|---|---|');
  for (const x of rows) {
    const st = x.t.state === 'ok' ? `✅ ${x.t.where}`
      : x.t.state === 'stale' ? '⚠️ 索引里没有（先 reindex）'
        : x.t.state === 'ambiguous' ? `⚠️ 不唯一｜${x.t.where}` : '❌ 目标不存在';
    const arch = ARCHIVED_PAGES.has(x.page) ? '（归档页）' : '';
    log(`| ${x.page}:${x.line}${arch} | ${x.r.type || '—'} | ${x.r.page} | ${short(x.r.key, 40)} | ${st} |`);
  }
  if (amb.length) {
    log('');
    log(`⚠️ **${amb.length} 条指向不确定**（key 在目标页命中多条 —— \`search.mjs\` 会静默取第一条，边指哪全看条目顺序）：`);
    for (const x of amb) log(`  - ${x.page}:${x.line} → rel:${x.r.page}:${x.r.key}（${x.t.where}）`);
  }
  if (stale.length) {
    log('');
    log(`⚠️ **${stale.length} 条索引滞后**（页面条目里有、index.json 里没有）—— 多半是改完页面没 reindex：`);
    for (const x of stale) log(`  - ${x.page}:${x.line} → rel:${x.r.page}:${x.r.key}`);
  }
  if (bad.length) {
    log('');
    log(`❌ **${bad.length} 条坏边**（索引与页面都定位不到目标 —— 检索端会静默丢弃它）：`);
    for (const x of bad) log(`  - ${x.page}:${x.line} → rel:${x.r.page}:${x.r.key}${x.r.type ? `:${x.r.type}` : ''}`);
    log('  修法：`cli rel rm` 删掉，或 `cli rel add` 重新连到一个存在且唯一的目标。');
  }
}

/** `rel add` / `rel rm`：默认 dry-run，`--apply` 才写。 */
function cmdEdit({ sub, positional, items, docs, opt, log, dir }) {
  const args = positional.slice(1);      // positional[0] 是 'add' / 'rm'
  const [aRef, bArg, cArg] = args;
  const type = sub === 'add' ? bArg : (bArg && bArg !== '-' ? bArg : null);
  const dRef = sub === 'add' ? cArg : cArg;
  const src = parseRef(aRef); const dst = parseRef(dRef);
  if (!src || !dst) { log(`❌ 定位写法不对：${USAGE}`); process.exitCode = 2; return; }
  if (sub === 'add' && !REL_TYPES.has(type)) {
    log(`❌ 类型「${type}」不合法。合法类型：${[...REL_TYPES].join(' | ')}`);
    process.exitCode = 2; return;
  }
  if (sub === 'rm' && type && !REL_TYPES.has(type)) {
    log(`❌ 类型「${type}」不合法（可省略或用 `-` 表示不限）。合法类型：${[...REL_TYPES].join(' | ')}`);
    process.exitCode = 2; return;
  }
  const kp = keyProblem(src.kw) || keyProblem(dst.kw);
  if (kp) { log(`❌ 关键词不能写进 rel：${kp}`); process.exitCode = 2; return; }

  const sL = locate(items, src); if (sL.error) { log(`❌ 源：${sL.error}${sL.candidates ? `\n${sL.candidates}` : ''}`); process.exitCode = 1; return; }
  const dL = locate(items, dst); if (dL.error) { log(`❌ 目标：${dL.error}${dL.candidates ? `\n${dL.candidates}` : ''}`); process.exitCode = 1; return; }
  const sHit = sL.hit; const dHit = dL.hit;
  // 目标必须能被**检索端**定位（docs 判据）—— 否则连上去也永远扩不到，等于写了一条死边。
  const tState = targetState(docs, items, { page: dst.page, key: dst.kw });
  const sState = targetState(docs, items, { page: src.page, key: src.kw });
  if (tState.state !== 'ok') {
    log(`❌ 目标在检索端定位不到（${tState.state === 'stale'
      ? '页面条目里有、但 index.json 里没有 ⇒ 多半是没 reindex'
      : tState.state === 'ambiguous' ? 'key 命中多条，指向不确定'
        : '索引与页面条目都没有'}）：${dst.page}:${dst.kw}`);
    if (tState.state === 'stale') log(`   先跑：node E:\\2\\_dsh_memory\\tools\\reindex-page.mjs ${dst.page}`);
    else if (tState.state === 'ambiguous') log(`   换个更长的关键词（${tState.where}）`);
    else log('   换个能唯一定位到条目的关键词，或先把那页补进索引。');
    process.exitCode = 1; return;
  }

  // 边体：
  //   add ⇒ 用**用户给的关键词**（已验证能在检索端唯一定位到该条目）；
  //   rm  ⇒ 必须用**页面上实际写着的字面**，不能用用户给的词 —— 写入时的 key 是从 title 截断/带 `**`
  //         的原文（如 `**数字输入容错范式**（闰年那题演化出`），用户不可能精确复述。实测按字面匹配
  //         会报「该行没有这条边」而删不掉 ⇒ 改成**按目标条目身份（docs id）**找回那条边的原字面。
  let body; let backBody = null;
  if (sub === 'add') {
    body = `${dst.page}:${dst.kw}${type ? `:${type}` : ''}`;
    backBody = `${src.page}:${src.kw}${type ? `:${type}` : ''}`;
  } else {
    body = pickExistingEdge(sHit, dst.page, tState.where, docs, type);
    if (opt('both')) backBody = pickExistingEdge(dHit, src.page, sState.where, docs, type);
    if (!body || (opt('both') && !backBody)) {
      log(`❌ 源条目上找不到指向 ${dst.page}（${tState.where}）的边${type ? `、且类型为 ${type}` : ''}。`);
      log(`   现有边：${(parseMeta(sHit.raw).meta.rel || []).map((r) => `rel:${r.page}:${r.key}${r.type ? `:${r.type}` : ''}`).join('  ') || '（无）'}`);
      process.exitCode = 1; return;
    }
  }

  const plan = [];
  const planOne = (hit, b, label) => {
    const lines = readLines(dir, hit.page);
    if (!lines) { plan.push({ hit, label, error: `读不到 ${hit.page}` }); return; }
    const res = applyRelOp(lines[hit.line - 1], { val: `rel:${b}`, op: sub });
    plan.push({ hit, label, res, lines, body: b });
  };
  planOne(sHit, body, '源');
  if (opt('both')) planOne(dHit, backBody, '目标');

  const changed = plan.filter((p) => p.res && p.res.changed);
  const unchanged = plan.filter((p) => p.res && !p.res.changed);
  const failed = plan.filter((p) => p.error || (p.res && !p.res.changed && sub === 'rm'));

  log(`${sub === 'add' ? '连接' : '断开'}：${sHit.page}:${sHit.line} ${sub === 'add' ? '→' : '×'} ${dHit.page}:${dHit.line}`
    + `（类型 ${type || '无'}${opt('both') ? '｜双向' : '｜单向'}）`);
  log(`  源条目：${short(sHit.title, 60)}`);
  for (const p of plan) {
    if (p.error) { log(`  ❌ ${p.label}：${p.error}`); continue; }
    if (!p.res.changed) { log(`  · ${p.label} 无需改动：${p.res.why}`); continue; }
    log(`  ${opt('apply') ? '✔ 写入' : '（dry-run）'} ${p.label} ${p.hit.page}:${p.hit.line}  rel:${p.body}`);
  }
  if (!opt('apply')) {
    log(changed.length ? '\n确认无误后加 --apply 执行（会先写 <页>.bak-rel-<ts> 备份）' : '\n没有需要改动的地方。');
    return;
  }
  if (!changed.length) { log('\n没有需要改动的地方，未落笔。'); return; }
  const ts = Date.now();
  // ⚠️ 必须**按页聚合、一页只写一次**（2026-11-09 测试抓到）：`--both` 在**同一页**两端各改一条时，
  //   若逐条 savePage，第二次写用的是另一份独立读出的 lines（不含第一次的改动）⇒ 后写覆盖前写、
  //   静默丢掉一条边。分组后同一页共用一份行数组，备份也只留一份。
  const byPage = new Map();
  for (const p of changed) {
    if (!byPage.has(p.hit.page)) byPage.set(p.hit.page, { lines: readLines(dir, p.hit.page), hits: [] });
    byPage.get(p.hit.page).hits.push(p);
  }
  const touched = [];
  for (const [page, g] of byPage) {
    if (!g.lines) { log(`  ❌ ${page}：读不到，跳过`); continue; }
    for (const p of g.hits) g.lines[p.hit.line - 1] = p.res.line;
    const bak = savePage(dir, page, g.lines, ts);
    touched.push(`${page}（备份 ${path.basename(bak)}）`);
  }
  log(`\n✅ 已写入 ${changed.length} 处：${touched.join('、')}`);
  log('⚠️ 下一步必须 reindex，否则 index.json 里的 meta.rel 还是旧的：');
  for (const p of changed) log(`   node E:\\2\\_dsh_memory\\tools\\reindex-page.mjs ${p.hit.page}`);
  if (unchanged.length) log(`（${unchanged.length} 处本来就无需改动）`);
  if (failed.length) log(`（${failed.length} 处没改成：${failed.map((p) => p.label).join('、')}）`);
}

/**
 * `cli rel [list|add|rm]`
 *   list 看全部边（标坏边）；add / rm 默认 dry-run，`--apply` 才写。
 *   `--both` 双向（add 时两端都连上、rm 时两端都断开）。
 */
export function runRelCommand({ sub = 'list', positional = [], opt, log, dir }) {
  // 两套数据各有分工，别混用（2026-11-09 实测踩过，见 scanEdges 注释）：
  //   `items` = listItems 的实时条目（按行切）——**只用来定位「源条目」拿行号**（写入要行号）；
  //   `docs`  = index.json 的文档（条目型页按条、其余按 `##` 节）——**目标可达性以它为准**（那是检索端真相）。
  const items = listItems(dir);
  const docs = readJson(path.join(dir, 'index.json'), { docs: [] }).docs || [];
  if (sub === 'list') return cmdList({ items, docs, opt, log, dir });
  if (sub === 'add' || sub === 'rm') return cmdEdit({ sub, positional, items, docs, opt, log, dir });
  log(`❌ 未知子命令「${sub}」\n${USAGE}`);
  process.exitCode = 2;
}
