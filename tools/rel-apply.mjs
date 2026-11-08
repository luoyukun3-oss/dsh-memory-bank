#!/usr/bin/env node
// ============================================================================
// rel-apply.mjs —— 把「人审 / 子智能体审过的关联候选」写成条目上的 `rel:` 边
//
// 用法：
//   node tools/rel-apply.mjs <verdicts.json>            干跑：只报告会写什么（默认）
//   node tools/rel-apply.mjs <verdicts.json> --apply    真写（逐页备份 + 否决记入 discarded）
//   可选 --repo <仓库目录>（默认 E:/2/_dsh_memory/repos/e-2）
//
// 输入（数组；yes 建边，no 记入 dream-discarded.json 以免 dream 每天重报同一批）：
//   [{ "a": "lessons.md#4", "b": "aliases.md#18", "verdict": "yes", "type": "scenario" }, …]
//   a/b 是**条目 id**（`页名#序号`，序号见 `cli items --page <页>` 或 index.json 的 docs 顺序）
//
// ⚠️ 三条硬教训（2026-10-13 建 40 条边时踩出来的，**全部静默、一句报错都没有**，故固化在此）：
//   ① **key 必须从原始 title 里原样截取**，一个字符都不改：`search.mjs` 拿 key 去 `d.title`/`d.text`
//      **原文**（含 `**`、`|`）做 `includes`。第一版我把 title 清洗（去 `**`）后才截 ⇒ 写进去的
//      29 条边**永远匹配不到**（现象只是"关键词无法唯一定位"，真因是两边比较方式不对称）⇒ 已全部回滚重来。
//   ② key 里**不能有 `,` 或 `:`** —— 前者是 `rel:` 的多值分隔符、后者是类型分隔符，含了就换个起点/长度。
//   ③ 写完**必须自检**：`docs.find(page && title/text.includes(key)).id === 目标 id`
//      —— `search.mjs` 用的正是这个 find（取**第一个**匹配），不唯一定位就会跳到别的条目上。
//
// ⚠️ 还有一条判断（不是 bug，是**用途**）：`rel:` 扩展名额只有 2 个，且命中过的条目会被 `!got.has()`
//    去重 ⇒ **「同一件事的多页落点」**（events 记经过 / lessons 记结论 / faults 记速查，通常是同一天）
//    建边**检索收益≈0**（同一查询会同时命中两端）。要占名额就留**跨主题**的边。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const opt = (n, fb) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : fb; };
const REPO = opt('--repo', 'E:/2/_dsh_memory/repos/e-2');
// ⚠️ 别用 `argv.find(a => a !== argv[argv.indexOf('--repo') + 1])` 那套：`--repo` 缺席时
// `indexOf` 返回 -1 ⇒ `argv[0]` 被当成「--repo 的值」而滤掉，第一个位置参数就丢了（2026-10-13 干跑抓到）。
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--repo') { i++; continue; }
  if (!argv[i].startsWith('--')) positional.push(argv[i]);
}
const SRC = positional[0];
if (!SRC) { console.error('用法：node tools/rel-apply.mjs <verdicts.json> [--apply] [--repo <dir>]'); process.exit(2); }

const PD = path.join(REPO, 'pages');
const docs = JSON.parse(fs.readFileSync(path.join(REPO, 'index.json'), 'utf8')).docs;
const byId = new Map(docs.map((d, i) => [d.id || `${d.page}#${i}`, d]));
const verdicts = JSON.parse(fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, ''));
// ⚠️ 必须去 BOM：Windows 上 PowerShell 的 `Set-Content -Encoding UTF8`、记事本、WPS 写出的
// UTF-8 都带 BOM，而 `JSON.parse` **不认 BOM**（报 `Unexpected token ''`）—— 2026-10-13 干跑踩到。

/** 从原始 title 里截一段能**唯一定位**该条目的 key（见文件头 ① ② ③）。 */
function pickKey(targetId) {
  const d = byId.get(targetId);
  if (!d) return null;
  const raw = String(d.title || '').trim() || String(d.text || '').trim();
  // ⚠️ key **绝不能含空白**：`rel:` 的值是按空白切分的（`parseMeta`）⇒ 含空格的 key 会被**静默切碎**
  // （`rel:lessons.md:2026-09-18 **Get-Co` 解析后 key 只剩 `2026-09-18`，边就指错/指空了）。
  // 这与 `cue:` 值含空格是**同一个坑**（2026-10-13 一天内犯了第二次）⇒ 只在**无空白片段**里取 key。
  for (const chunk of raw.split(/\s+/).filter(Boolean)) {
    for (const n of [chunk.length, 16, 12, 8]) {
      const k = chunk.slice(0, n).trim();
      if (k.length < 5 || /[,:\s]/.test(k)) continue;   // 教训 ②（外加空白）
      const f = docs.find((x) => x.page === d.page && ((x.title || '').includes(k) || (x.text || '').includes(k)));
      if (f && f.id === targetId) return k;             // 教训 ③：与 search 同一判据
    }
  }
  return null;
}

const edits = new Map();     // page → [{id, val, anchor}]
const skipped = [];
let yes = 0, no = 0;
for (const v of verdicts) {
  const { a, b, verdict, type } = v;
  if (verdict === 'no') { no++; continue; }   // 否决只写 discarded，不动页面
  if (verdict !== 'yes') { skipped.push(`${a} × ${b}（verdict=${verdict}，跳过）`); continue; }
  const ka = pickKey(a); const kb = pickKey(b);
  if (!ka || !kb) { skipped.push(`${a} × ${b}（关键词无法唯一定位：a=${ka} b=${kb}）`); continue; }
  const pa = a.split('#')[0]; const pb = b.split('#')[0];
  const t = type ? `:${type}` : '';
  for (const [id, val, anchor] of [[a, `rel:${pb}:${kb}${t}`, ka], [b, `rel:${pa}:${ka}${t}`, kb]]) {
    const page = id.split('#')[0];
    if (!edits.has(page)) edits.set(page, []);
    edits.get(page).push({ id, val, anchor });
  }
  yes++;
}

console.log(`${APPLY ? '写入' : '干跑'}：yes ${yes} 组 ｜ no ${no} 组 ｜ 跳过 ${skipped.length} 组`);
if (skipped.length) console.log('跳过：\n  ' + skipped.join('\n  '));
if (!APPLY) {
  for (const [page, list] of edits) for (const e of list) console.log(`  [${page}] ${e.id}  += ${e.val}`);
  console.log('\n（干跑结束；加 --apply 才真写）');
  process.exit(0);
}

const ts = Date.now();
for (const [page, list] of edits) {
  const f = path.join(PD, page);
  const raw0 = fs.readFileSync(f);
  const hasBom = raw0[0] === 0xEF && raw0[1] === 0xBB && raw0[2] === 0xBF;
  const lines = raw0.toString('utf8').replace(/^\uFEFF/, '').split('\n');
  let hit = 0;
  for (const { id, val, anchor } of list) {
    // 条目首行可能是 `- `、缩进子项 `    - `、或表格行 `| … |`（faults/index-files 用表格）
    const li = lines.findIndex((l) => /^\s*[-|]/.test(l) && l.includes(anchor));
    if (li < 0) { skipped.push(`${id} 定位不到行（anchor=${anchor}）`); continue; }
    if (lines[li].includes(val)) continue;                                    // 幂等
    if (/\brel:/.test(lines[li])) {                                           // 已有 rel ⇒ 追加成多值
      lines[li] = lines[li].replace(/(\brel:)([^\s]*)/, (_, p, x) => `${p}${x},${val.replace(/^rel:/, '')}`);
    } else if (/<!--[\s\S]*?-->/.test(lines[li])) {                            // 有别的元数据 ⇒ 塞进同一注释
      lines[li] = lines[li].replace(/(<!--)([\s\S]*?)(-->)/, (_, x, y, z) => `${x}${y.trimEnd()} ${val} ${z}`);
    } else {
      lines[li] = `${lines[li].trimEnd()} <!-- ${val} -->`;
    }
    hit++;
  }
  fs.writeFileSync(`${f}.bak-rel-${ts}`, raw0);                                // 改前逐页备份
  fs.writeFileSync(f, (hasBom ? '\uFEFF' : '') + lines.join('\n'), 'utf8');    // 保持原 BOM 状态
  console.log(`  [${page}] 写入 ${hit} 处`);
}

const nos = verdicts.filter((v) => v.verdict === 'no');
if (nos.length) {
  const disc = path.join(REPO, 'dream-discarded.json');
  const dj = fs.existsSync(disc) ? JSON.parse(fs.readFileSync(disc, 'utf8')) : { items: [] };
  dj.items = dj.items || [];
  for (const v of nos) { dj.items.push(`${v.a}|${v.b}`); dj.items.push(`${v.b}|${v.a}`); }
  dj.items = [...new Set(dj.items)];
  fs.writeFileSync(disc, JSON.stringify(dj, null, 1) + '\n', 'utf8');
  console.log(`否决 ${nos.length} 组 → dream-discarded.json（共 ${dj.items.length} 条）`);
}
if (skipped.length) console.log('⚠️ 跳过（未写入）：\n  ' + skipped.join('\n  '));
console.log(`\n受影响页：${[...edits.keys()].join(' ')}`);
console.log('⚠️ 下一步必须 reindex（否则 index.json 里的 meta.rel 还是旧的）：');
for (const page of edits.keys()) console.log(`   node E:/2/_dsh_memory/tools/reindex-page.mjs ${page}`);
