#!/usr/bin/env node
// ============================================================================
// star-map —— 把记忆银行渲染成「记忆星图」（单文件 HTML，离线可开）
//
//   node _dsh_memory/tools/star-map.mjs [repo目录] [输出html]
//
// 由来（2026-11-08）：`E:\2\记忆星图.html` 是 2026-11-04 手搓的一个成品（422 KB，
//   深色星空风 + 星团 + 时间轴 + 搜索），但它**数据是死写在里面的、没有生成器**
//   （文件里那句「自动生成，勿手改」说明当时有脚本，脚本没留下）。
//   这里把它的**样式与渲染代码原样保留**（切成 `star-map-template.html`），
//   只重写数据段 ⇒ 变成可反复生成的活图。
//
// 数据源（全部只读）：index.json（条目 + meta）、cooccur.json（共现）
// 与 graph-render.mjs 的差别：那个是「力导向关系图」，这个是「星团星图」——
//   前者看**边**，后者看**群**。两者并存，别互相替代。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] || 'E:/2/_dsh_memory/repos/e-2';
const outFile = process.argv[3] || path.join(repo, 'star-map.html');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const idx = readJson(path.join(repo, 'index.json'));
const hasCo = fs.existsSync(path.join(repo, 'cooccur.json'));
const co = hasCo ? readJson(path.join(repo, 'cooccur.json')) : {};

/** 页 → 星团（视觉参数沿用原版：ax 角度、ar 半径、spread 散布、layer 层） */
const CLUSTER_DEFS = [
  { id: 'cl_lessons', name: '教训星团', layer: 1, ax: -2.3, ar: 262, spread: 132, page: 'lessons.md', type: 'lesson' },
  { id: 'cl_procedures', name: '招式星团', layer: 1, ax: -0.62, ar: 300, spread: 92, page: 'procedures.md', type: 'procedure' },
  { id: 'cl_events', name: '事件星系', layer: 2, ax: 0.56, ar: 274, spread: 104, page: 'events.md', type: 'event' },
  { id: 'cl_faults', name: '故障星云', layer: 2, ax: 2.28, ar: 336, spread: 112, page: 'faults.md', type: 'fault' },
  { id: 'cl_decisions', name: '决策星环', layer: 2, ax: 2, ar: 306, spread: 92, page: 'decisions.md', type: 'decision' },
  { id: 'cl_aliases', name: '别名词云', layer: 2, ax: -1.66, ar: 342, spread: 80, page: 'aliases.md', type: 'alias' },
  { id: 'cl_pref', name: '偏好星团', layer: 1, ax: -1.42, ar: 356, spread: 62, page: 'preferences.md', type: 'pref' },
  { id: 'cl_env', name: '环境星团', layer: 3, ax: 1.16, ar: 400, spread: 70, page: 'environment.md', type: 'env' },
  { id: 'cl_journal', name: '流水星系', layer: 3, ax: 0.14, ar: 452, spread: 118, pagePrefix: 'journal/', type: 'journal' },
  { id: 'cl_other', name: '归档星团', layer: 3, ax: -1.02, ar: 424, spread: 84, page: null, type: 'other' },
];

const PER_CLUSTER = 26;   // 每团显示多少条（原版就是 26）

const pageOf = (id) => String(id).split('#')[0];

/** 截断标签：原版标签都带「…」，太长会把节点撑爆 */
const label = (s, n = 16) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** 生成 JS 双引号字符串字面量（安全转义） */
const q = (s) => JSON.stringify(String(s == null ? '' : s));

// —— 分组：按页归到星团 ——
const buckets = new Map();   // clusterId -> docs[]
for (const c of CLUSTER_DEFS) buckets.set(c.id, []);

const known = new Set(CLUSTER_DEFS.map((c) => c.page).filter(Boolean));
for (const d of idx.docs || []) {
  if (!d.id) continue;
  const p = pageOf(d.id);
  const exact = CLUSTER_DEFS.find((c) => c.page === p);
  if (exact) { buckets.get(exact.id).push(d); continue; }
  if (p.startsWith('journal/')) { buckets.get('cl_journal').push(d); continue; }
  buckets.get('cl_other').push(d);
}

// 每团按「重要度 + 度数」排序取前 N —— 让最该被看见的星点出现在图上
const degOf = new Map();
for (const [a, targets] of Object.entries(co)) {
  degOf.set(a, (degOf.get(a) || 0) + Object.keys(targets || {}).length);
}
const scoreOf = (d) => (d.meta && d.meta.importance ? d.meta.importance * 10 : 0) + (degOf.get(d.id) || 0);

// —— 生成数据段 ——
const L = [];
L.push('/* ===== 记忆银行星图数据（由 tools/star-map.mjs 生成，勿手改） ===== */');
L.push('const CLUSTERS = [');
for (const c of CLUSTER_DEFS) {
  L.push(`  { id: ${q(c.id)}, name: ${q(c.name)}, layer: ${c.layer}, ax: ${c.ax}, ar: ${c.ar}, spread: ${c.spread}, anchor: ${q('a_' + c.id)} },`);
}
L.push('];');
L.push('');
L.push('const NODES = [];');
const totalDocs = (idx.docs || []).length;
const coreSummary = `${totalDocs} 条索引 · ${CLUSTER_DEFS.length} 个星团 · 跨会话记忆本体`;
L.push(`const CORE = N(${q('记忆银行')}, 0, 'core', 13, 1, 'cl_core', { summary: ${q(coreSummary)} });`);
L.push("CORE.id = 'core';");
L.push('NODES.push(CORE);');
L.push('function add(arr, cluster) { arr.forEach(n => { n.cluster = cluster; NODES.push(n); }); }');
L.push('');

let shown = 0;
for (const c of CLUSTER_DEFS) {
  const list = (buckets.get(c.id) || []).slice();
  if (!list.length) continue;
  list.sort((a, b) => scoreOf(b) - scoreOf(a));
  const picked = list.slice(0, PER_CLUSTER);
  const total = list.length;
  const anchorSummary = c.id === 'cl_other'
    ? `共 ${total} 条未归入专属星团的条目，星图展示前 ${picked.length} 条。`
    : `共 ${total} 条，星图展示前 ${picked.length} 条。`;

  L.push(`const g_${c.id} = [`);
  L.push(`N(${q('「' + c.name + '」')}, ${c.layer}, ${q(c.type)}, 13, .95, '', { key: ${q('a_' + c.id)}, summary: ${q(anchorSummary)} }),`);
  picked.forEach((d, i) => {
    const t = label(d.title || d.text || d.id);
    const sum = String(d.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    L.push(`N(${q(t)}, ${c.layer}, ${q(c.type)}, 13, 1.00, '', { key: ${q('n_' + c.id + '_' + i)}, summary: ${q(sum)} }),`);
  });
  L.push('];');
  L.push(`add(g_${c.id}, ${q(c.id)});`);
  L.push('');
  shown += picked.length;
}

L.push('/* ===== 数据段结束 ===== */');

// —— 套模板 ——
const tplPath = path.join(HERE, 'star-map-template.html');
if (!fs.existsSync(tplPath)) {
  console.error('找不到模板: ' + tplPath);
  process.exit(1);
}
const tpl = fs.readFileSync(tplPath, 'utf8');
if (!tpl.includes('__STAR_DATA__')) {
  console.error('模板里没有 __STAR_DATA__ 占位符');
  process.exit(1);
}

// 顶部那行统计（原版写死「2069 条索引 · 10 个星团」）也一并替换成真实值
let html = tpl.replace('__STAR_DATA__', L.join('\n'));
html = html.replace(/2069 条索引 · 10 个星团/, `${totalDocs} 条索引 · ${CLUSTER_DEFS.length} 个星团`);

fs.writeFileSync(outFile, html, 'utf8');

console.log('星图已生成: ' + outFile);
console.log(`索引 ${totalDocs} 条 · 星团 ${CLUSTER_DEFS.length} 个 · 图上星点 ${shown} 个（每团 ≤${PER_CLUSTER}）`);
console.log('大小 ' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB');
