#!/usr/bin/env node
// ============================================================================
// rel-type.mjs —— 给**已经存在、但没标类型**的 `rel:` 边补上 type（不新增边）
//
// 为什么单独一个工具：`rel-apply.mjs` 是「新增边」的，对已存在的边再跑一遍会把值
// 追加成 `rel:页:key,rel:页:key:type` ⇒ 同一条边出现两份（一份无类型一份有类型）。
// 这个工具只做一件事：把 `rel:<页>:<key>` 就地改成 `rel:<页>:<key>:<type>`。
//
// 用法：
//   node tools/rel-type.mjs <verdicts.json>             干跑
//   node tools/rel-type.mjs <verdicts.json> --apply     真写（逐页备份，保持原 BOM）
//   可选 --repo <仓库目录>
//
// 输入：[{ "from": "lessons.md#261", "toId": "procedures.md#10", "type": "sequence" }]
//   from/toId 是**条目 id**（index.json 的 docs 顺序），type 必须在 REL_TYPES 里。
//   工具自己去 from 的 meta.rel 里挑出「指向 toId 且没类型」的那条，拿到它的 key，
//   再到页面正文里替换 —— 所以**不用你手写 key**（手写 key 正是 rel-apply 头注释里的坑①）。
//
// 单向：只改 from 这一端。要双向都带类型，就正反各给一条 verdicts。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const opt = (n, fb) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : fb; };
const REPO = opt('--repo', 'E:/2/_dsh_memory/repos/e-2');
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--repo') { i++; continue; }
  if (!argv[i].startsWith('--')) positional.push(argv[i]);
}
const SRC = positional[0];
if (!SRC) { console.error('用法：node tools/rel-type.mjs <verdicts.json> [--apply] [--repo <dir>]'); process.exit(2); }

const PD = path.join(REPO, 'pages');
const docs = JSON.parse(fs.readFileSync(path.join(REPO, 'index.json'), 'utf8')).docs;
const find = (page, key) => docs.find((d) => d.page === page
  && ((d.title || '').includes(key) || (d.text || '').includes(key)));
const REL_TYPES = new Set(['causal', 'sequence', 'scenario', 'attribute', 'preference', 'social', 'temporal']);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const verdicts = JSON.parse(fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, ''));
const edits = new Map();   // page -> [{ id, toPage, key, type }]
const skipped = [];
let okCount = 0;

for (const v of verdicts) {
  const { from, toId, type } = v;
  if (!REL_TYPES.has(type)) { skipped.push(`${from} → ${toId}: 非法类型 ${type}`); continue; }
  const a = docs.find((d) => d.id === from);
  const b = docs.find((d) => d.id === toId);
  if (!a || !b) { skipped.push(`${from} → ${toId}: 条目不存在`); continue; }
  const rels = (a.meta && a.meta.rel) || [];
  const hit = rels.find((r) => !r.type && r.page === b.page && (find(r.page, r.key) || {}).id === b.id);
  if (!hit) { skipped.push(`${from} → ${toId}: 找不到对应的「无类型 rel」`); continue; }
  if (!edits.has(a.page)) edits.set(a.page, []);
  edits.get(a.page).push({ id: from, toPage: b.page, key: hit.key, type });
  okCount += 1;
}

console.log(`${APPLY ? '写入' : '干跑'}：可补 ${okCount} 条 ｜ 跳过 ${skipped.length} 条`);
if (skipped.length) console.log('跳过：\n  ' + skipped.slice(0, 20).join('\n  '));
if (!APPLY) {
  for (const [page, list] of edits) for (const e of list) {
    console.log(`  [${page}] ${e.id}  rel:${e.toPage}:${e.key}  →  :${e.type}`);
  }
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
  for (const e of list) {
    // 只认「后面紧跟空白 / 逗号 / 注释结束 / 行尾」的那个，避免 key 互为前缀时替换错
    const re = new RegExp(`rel:${esc(e.toPage)}:${esc(e.key)}(?=[\\s,]|-->|$)`);
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      lines[i] = lines[i].replace(re, `rel:${e.toPage}:${e.key}:${e.type}`);
      hit += 1; done = true;
      break;
    }
    if (!done) skipped.push(`${e.id}: 正文里找不到 rel:${e.toPage}:${e.key}`);
  }
  fs.writeFileSync(`${f}.bak-reltype-${ts}`, raw0);
  fs.writeFileSync(f, (hasBom ? '\uFEFF' : '') + lines.join('\n'), 'utf8');
  console.log(`  [${page}] 补类型 ${hit} 处`);
}
if (skipped.length) console.log('⚠️ 跳过（未写入）：\n  ' + skipped.join('\n  '));
console.log(`\n受影响页：${[...edits.keys()].join(' ')}`);
console.log('⚠️ 下一步必须 reindex：');
for (const page of edits.keys()) console.log(`   node E:/2/_dsh_memory/tools/reindex-page.mjs ${page}`);
