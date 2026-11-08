#!/usr/bin/env node
// ============================================================================
// rel-rewrite.mjs —— 把一行的 **整个 rel 段**替换成给定值（空字符串 = 删掉这条边）
//
// 用在 rel-fix 处理不了的地方：历史 rel 值里塞了多条边、缺逗号、被空白切碎，
// 已经不是「换一个 key」能救的，只能整段重写。
//
// 输入 JSON：`[{ "id": "lessons.md#90", "newRel": "" }]`
//   - `id`     —— index.json 的条目 id
//   - `newRel` —— 新 rel 段（**不含** `rel:` 前缀），如 `lessons.md:某片段:scenario`；
//                 给空串或省略 = 删掉该行的 rel 段（其他字段如 cue/i 保留）
//
// 用法：node tools/rel-rewrite.mjs <plan.json> [--apply]
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PLAN = argv.find((a) => !a.startsWith('--'));
if (!PLAN) { console.error('用法：node tools/rel-rewrite.mjs <plan.json> [--apply]'); process.exit(1); }

const REPO = 'E:/2/_dsh_memory/repos/e-2';
const PD = path.join(REPO, 'pages');
const docs = JSON.parse(fs.readFileSync(path.join(REPO, 'index.json'), 'utf8')).docs;

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8').replace(/^\uFEFF/, ''));
const byPage = new Map();
const skipped = [];

for (const item of plan) {
  const d = docs.find((x) => x.id === item.id);
  if (!d) { skipped.push(`${item.id}: 条目不存在`); continue; }
  const title = String(d.title || '');
  if (!byPage.has(d.page)) byPage.set(d.page, []);
  byPage.get(d.page).push({ ...item, title });
}

let totalOK = 0;
for (const [page, items] of byPage) {
  const f = path.join(PD, page);
  const raw = fs.readFileSync(f);
  const hasBom = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
  const lines = raw.toString('utf8').replace(/^\uFEFF/, '').split('\n');
  for (const it of items) {
    // 按标题前缀定位（30 → 20 → 14 字逐级退）
    let li = -1;
    for (const n of [30, 20, 14]) {
      const probe = it.title.slice(0, n);
      if (!probe) continue;
      li = lines.findIndex((l) => l.includes(probe));
      if (li >= 0) break;
    }
    if (li < 0) { skipped.push(`${it.id}: 行定位失败`); continue; }
    const line = lines[li];
    const cm = line.match(/<!--([\s\S]*?)-->/);
    if (!cm) { skipped.push(`${it.id}: 该行没有注释块`); continue; }
    const body = cm[1];
    const ri = body.indexOf('rel:');
    if (ri < 0) { skipped.push(`${it.id}: 注释里没有 rel:`); continue; }
    // rel 段 = 从 `rel:` 到结尾（保留前面可能有的 cue:/i: 等字段）
    const head = body.slice(0, ri).replace(/\s+$/, '');
    const newBody = it.newRel
      ? `${head}${head ? ' ' : ''}rel:${it.newRel}`
      : head;
    lines[li] = line.replace(/<!--[\s\S]*?-->/, `<!-- ${newBody}${newBody ? ' ' : ''}-->`);
    totalOK++;
    console.log(`  ${it.id}  →  ${it.newRel ? 'rel:' + it.newRel : '(删掉 rel 段)'}`);
  }
  if (APPLY) {
    fs.writeFileSync(`${f}.bak-rewrite-${Date.now()}`, raw);
    fs.writeFileSync(f, (hasBom ? '\uFEFF' : '') + lines.join('\n'), 'utf8');
  }
}
console.log(`\n${APPLY ? '已写入' : '干跑'}：${totalOK} 条 ｜ 跳过 ${skipped.length} 条`);
if (skipped.length) console.log('  ' + skipped.join('\n  '));
