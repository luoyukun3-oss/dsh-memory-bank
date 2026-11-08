#!/usr/bin/env node
/**
 * star-map —— 把记忆银行渲染成「记忆星图」（单文件 HTML，离线可开）
 *
 *   node tools/star-map.mjs [repo目录] [输出html]
 *
 * ★ 2026-11-08：本文件是 `E:\2\_gen_star.mjs`（2026-11-04 手搓那个的生成器）的**正式化版本**。
 *   原版只输出 `_gen_data.js` 让人手动贴进 HTML；这里直接套 `star-map-template.html` 出完整 HTML。
 *   **数据逻辑一行没改** —— 那是验证过能用的，包括：
 *     · 按页配额（lessons 26 / procedures 16 / events 20 / faults 14 / decisions 12 / …）
 *     · 节点带 body(3000) + title(120)，供点击展开
 *     · size 按正文长度算、score 也按长度算
 *     · LINKS（核心→锚点、锚点→节点）
 *     · DAYS + DAY_DATA（底部时间轴）
 *
 * ⚠️ 教训（2026-11-08 记）：我先自己重写了一套数据生成，**漏了 LINKS 和 DAYS**
 *    —— 语法检查能过，但渲染时连线与时间轴是空的。**产物里写着「自动生成」就说明生成器存在，
 *    找不到别急着重写，先把「生成」这件事本身搜干净**（原文件叫 `_gen_star.mjs`，躺在 E:\2 根目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] || 'E:/2/_dsh_memory/repos/e-2';
const outFile = process.argv[3] || path.join(repo, 'star-map.html');

const j = JSON.parse(fs.readFileSync(path.join(repo, 'index.json'), 'utf8'));
const docs = j.docs || [];

/** 页名归一化：journal 全部归到 cl_journal，其余取 basename */
function pageKey(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (s.includes('/journal/')) return 'journal';
  const b = s.split('/').pop();
  return b || 'other';
}

const groups = {};
for (const d of docs) {
  const k = pageKey(d.page);
  (groups[k] ||= []).push(d);
}

/** 每页取多少个代表节点 */
const QUOTA = {
  'lessons.md': 26,
  'procedures.md': 16,
  'events.md': 20,
  'faults.md': 14,
  'decisions.md': 12,
  'aliases.md': 6,
  'preferences.md': 6,
  'environment.md': 5,
  'todos.md': 4,
  'journal': 30,
};
const DEFAULT_QUOTA = 6;

/** 星团定义：id / 显示名 / 层级 / 角度 / 半径 / 散布 */
const CLUSTER_DEF = [
  { key: 'lessons.md',   id: 'cl_lessons',   name: '教训星团',   layer: 1, ax: -2.30, ar: 262, spread: 132, type: 'lesson',   tag: '教训' },
  { key: 'procedures.md',id: 'cl_procedures',name: '招式星团',   layer: 1, ax: -0.62, ar: 300, spread: 92,  type: 'procedure',tag: '招式' },
  { key: 'events.md',    id: 'cl_events',    name: '事件星系',   layer: 2, ax: 0.56,  ar: 274, spread: 104, type: 'event',    tag: '事件' },
  { key: 'faults.md',    id: 'cl_faults',    name: '故障星云',   layer: 2, ax: 2.28,  ar: 336, spread: 112, type: 'fault',    tag: '故障' },
  { key: 'decisions.md', id: 'cl_decisions', name: '决策星环',   layer: 2, ax: 2.00,  ar: 306, spread: 92,  type: 'decision', tag: '决策' },
  { key: 'aliases.md',   id: 'cl_aliases',   name: '别名词云',   layer: 2, ax: -1.66, ar: 342, spread: 80,  type: 'alias',    tag: '别名' },
  { key: 'journal',      id: 'cl_journal',   name: '流水星系',   layer: 3, ax: 0.14,  ar: 452, spread: 118, type: 'journal',  tag: '流水' },
  { key: 'other',        id: 'cl_other',     name: '归档星团',   layer: 3, ax: -1.02, ar: 424, spread: 84,  type: 'other',    tag: '其他' },
  { key: 'preferences.md', id: 'cl_pref',    name: '偏好星团',   layer: 1, ax: -1.42, ar: 356, spread: 62,  type: 'pref',     tag: '偏好' },
  { key: 'environment.md', id: 'cl_env',     name: '环境星团',   layer: 3, ax: 1.16,  ar: 400, spread: 70,  type: 'env',      tag: '环境' },
];

const clusterOfKey = {};
CLUSTER_DEF.forEach(c => { clusterOfKey[c.key] = c; });

/** 把未登记的页塞进 other */
for (const k of Object.keys(groups)) {
  if (!clusterOfKey[k]) {
    (groups['other'] ||= []).push(...groups[k]);
    delete groups[k];
  }
}

const esc = (s) => JSON.stringify(String(s ?? ''));

/** 标题清洗：去 markdown 记号、去日期前缀、压空白、截断 */
function cleanTitle(raw, n) {
  let s = String(raw ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^#+\s*/, '')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^【?\d{4}[-/]\d{1,2}[-/]\d{1,2}】?\s*/, '');
  s = s.replace(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+/, '');
  s = s.trim();
  if (!s) s = String(raw ?? '').trim().slice(0, n);
  if (s.length > n) s = s.slice(0, n) + '…';
  return s;
}

/** 摘要清洗：去换行、截断 */
function clip(t, n) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

const out = [];
out.push('/* ===== 记忆银行星图数据（由 tools/star-map.mjs 生成，勿手改） ===== */');
out.push('const CLUSTERS = [');
for (const c of CLUSTER_DEF) {
  const anchor = 'a_' + c.id;
  out.push(`  { id: '${c.id}', name: '${c.name}', layer: ${c.layer}, ax: ${c.ax}, ar: ${c.ar}, spread: ${c.spread}, anchor: '${anchor}' },`);
}
out.push('];');
out.push('');

// 核心节点（索引条数改成动态的 —— 原版写死 2069）
out.push('const NODES = [];');
out.push(`const CORE = N('记忆银行', 0, 'core', 13, 1, 'cl_core', { summary: '${docs.length} 条索引 · ${CLUSTER_DEF.length} 个星团 · 跨会话记忆本体' });`);
out.push("CORE.id = 'core';");
out.push('NODES.push(CORE);');
out.push('function add(arr, cluster) { arr.forEach(n => { n.cluster = cluster; NODES.push(n); }); }');
out.push('');

const anchors = [];
let totalNodes = 0;

for (const c of CLUSTER_DEF) {
  const list = (groups[c.key] || []).slice();
  if (!list.length) continue;
  // 排序：文本越长越"重"
  list.sort((a, b) => String(b.text || '').length - String(a.text || '').length);
  const quota = QUOTA[c.key] ?? DEFAULT_QUOTA;
  const picked = list.slice(0, quota);
  const varName = 'g_' + c.id;
  out.push(`const ${varName} = [`);
  // 锚点节点
  const anchorKey = 'a_' + c.id;
  out.push(`  N('「${c.name}」', ${c.layer}, '${c.type}', 13, .95, '', { key: ${esc(anchorKey)}, summary: '共 ${list.length} 条${c.tag}，星图展示前 ${picked.length} 条。', meta: [${esc(c.key)}, ${esc(list.length + ' 条')}] }),`);
  totalNodes++;
  anchors.push({ id: c.id, key: anchorKey });
  picked.forEach((d, i) => {
    const title = cleanTitle(d.title, 12) || '(无题)';
    const key = 'n_' + c.id + '_' + i;
    const len = String(d.text || '').length;
    const size = 7 + Math.min(6, Math.round(len / 120));
    const score = Math.max(.25, Math.min(1, .35 + len / 900));
    out.push(`  N(${esc(title)}, ${c.layer}, '${c.type}', ${size}, ${score.toFixed(2)}, '', { key: ${esc(key)}, summary: ${esc(clip(d.text, 160))}, body: ${esc(clip(d.text, 3000))}, title: ${esc(clip(d.title, 120))}, meta: [${esc(clip(d.page, 40))}] }),`);
    totalNodes++;
  });
  out.push('];');
  out.push(`add(${varName}, '${c.id}');`);
  out.push('');
}

// ⚠️ 这一行必须放在「连线」之前 —— 原文件里它在 L806、LINKS 生成在 L897（定义在前）。
//    2026-11-08 实测踩过：我一开始把它追加到数据段**末尾**，浏览器报
//    `Cannot access 'clusterById' before initialization`（TDZ）——`const` 在声明前不可用，
//    而 LINKS 那段就在它前面。**插入派生代码要看依赖顺序，不能图省事往末尾加。**
out.push('');
out.push('const clusterById = Object.fromEntries(CLUSTERS.map(c => [c.id, c]));');
out.push('');

// 连线：核心 → 各星团锚点、锚点 → 各节点
out.push('/* 连线 */');
out.push('const LINKS = [];');
out.push('const nodeByKey = {};');
out.push('NODES.forEach(n => { if (n.key) nodeByKey[n.key] = n; });');
out.push("function L(a, b, w) { const A = typeof a === 'string' ? nodeByKey[a] : a, B = typeof b === 'string' ? nodeByKey[b] : b; if (A && B) LINKS.push({ a: A, b: B, w: w || .5 }); }");
out.push("CLUSTERS.forEach(c => { const anchor = nodeByKey[c.anchor]; if (anchor) L(CORE, anchor, 1); });");
out.push('NODES.forEach(n => {');
out.push('  if (n === CORE || n.layer === 0) return;');
out.push('  const c = clusterById[n.cluster]; if (!c) return;');
out.push('  const anchor = nodeByKey[c.anchor];');
out.push('  if (anchor && anchor !== n) L(anchor, n, .45);');
out.push('});');
out.push('');

// 日期数据：取 journal 里出现过的日期（底部时间轴）
out.push('/* 日期数据 */');
const daySet = new Set();
for (const d of docs) {
  const m = String(d.page || '').match(/(\d{4}-\d{2}-\d{2})/);
  if (m) daySet.add(m[1]);
}
const days = [...daySet].sort().slice(-10);
out.push(`const DAYS = ${JSON.stringify(days)};`);
out.push('const DAY_DATA = {');
for (const d of days) {
  const cnt = docs.filter(x => String(x.page || '').includes(d)).length;
  out.push(`  '${d}': { has: ${cnt > 0 ? 1 : 0}, dens: ${Math.min(.95, .15 + cnt / 100).toFixed(2)}, note: '${cnt} 条' },`);
}
out.push('};');

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
const html = tpl.replace('__STAR_DATA__', out.join('\n'));

fs.writeFileSync(outFile, html, 'utf8');
console.log('星图已生成: ' + outFile);
console.log(`索引 ${docs.length} 条 · 星团 ${CLUSTER_DEF.length} 个 · 节点 ${totalNodes} 个 · 日期 ${days.length} 天`);
console.log('大小 ' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB');
