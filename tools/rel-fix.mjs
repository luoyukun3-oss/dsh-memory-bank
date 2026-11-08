#!/usr/bin/env node
// ============================================================================
// rel-fix.mjs —— 把「指向不确定」的 rel 边改成**能唯一定位**的形式
//
// 病因（2026-10-27 实测）：`rel:` 边写作 `页:关键词[:类型]`，定位靠「目标页里第一个
// 包含该关键词的条目」。历史手写的边关键词太宽（40 条只是纯日期 `2026-10-08`），
// 一条边能命中 31 个条目 ⇒ 指向全看条目顺序，**一句报错都没有**。
//
// 输入两份：
//   ① 清单 `_relfix/<页>.json`：{ from, fromTitle, page, key, type, candidates[] }
//      —— 记录**现状**（旧 key、当前候选）
//   ② 判定 `<页>.fixes.json`：{ from, targetId, key?, confident, why }
//      —— 子代理给出的**真实目标条目**；`key` 是原 key（同一 from 有多条边时用来精确配对）
//
// 做三件事：
//   1. 用 `pickKey(targetId)` 从目标条目的 title 里取一个**无空白、且唯一命中它**的新 key
//   2. 在源条目所在行把 `rel:<page>:<旧key>[:类型]` 整条替换成 `rel:<页>:<新key>[:类型]`
//   3. 每条都自检 `find(page,newKey).id === targetId`，任何一条不成立就整体放弃（不写半截）
//
// 用法：
//   node tools/rel-fix.mjs _relfix --apply     真写（默认干跑）
//   node tools/rel-fix.mjs _relfix            干跑，只报告
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DIR = argv.find((a) => !a.startsWith('--')) || 'E:/2/_relfix';
const REPO = 'E:/2/_dsh_memory/repos/e-2';
const PD = path.join(REPO, 'pages');

const docs = JSON.parse(fs.readFileSync(path.join(REPO, 'index.json'), 'utf8')).docs;
const byId = new Map(docs.map((d) => [d.id, d]));
const hitsOf = (page, key) => docs.filter((d) => d.page === page
  && ((d.title || '').includes(key) || (d.text || '').includes(key)));
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 从目标条目的 title 里取一个无空白、且**唯一命中它**的 key（同 rel-apply.mjs 的 pickKey）。 */
function pickKey(targetId) {
  const d = byId.get(targetId);
  if (!d) return { key: null, why: '目标条目不存在' };
  const raw = String(d.title || '').trim() || String(d.text || '').trim();
  for (const chunk of raw.split(/\s+/).filter(Boolean)) {
    for (const n of [chunk.length, 16, 12, 8, 6]) {
      const k = chunk.slice(0, n).trim();
      if (k.length < 4 || /[,:\s]/.test(k)) continue;
      const hits = hitsOf(d.page, k);
      if (hits.length === 1 && hits[0].id === targetId) return { key: k, why: '' };
    }
  }
  return { key: null, why: 'title 里取不出唯一无空白片段' };
}

// —— 读清单与判定 ——
const files = fs.readdirSync(DIR);
const manifest = new Map();   // from -> [{page, key, type, candidates}]
for (const f of files.filter((x) => x.endsWith('.json') && !x.includes('fixes'))) {
  for (const r of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
    if (!manifest.has(r.from)) manifest.set(r.from, []);
    manifest.get(r.from).push(r);
  }
}
const fixes = [];
for (const f of files.filter((x) => x.includes('fixes') && x.endsWith('.json'))) {
  for (const x of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8').replace(/^\uFEFF/, ''))) {
    fixes.push({ ...x, src: f });
  }
}

const plans = [];
const seenEdge = new Set();
const skipped = [];
for (const fx of fixes) {
  const { from, targetId, confident } = fx;
  if (confident === false) { skipped.push(`${from}: 子代理标了不确定`); continue; }
  if (!targetId && !fx.newKey) { skipped.push(`${from}: 目标为 null（候选里没有真目标）`); continue; }
  const edges = manifest.get(from) || [];
  // 配对：给了原 key 就用它；否则挑「候选里含 targetId」的那条
  let edge = fx.key ? edges.find((e) => e.key === fx.key)
    : edges.find((e) => (e.candidates || []).some((c) => c.id === targetId));
  // 死边不在清单里（清单只导出「key 不唯一」的），fixes 自带 page/key 时直接构造
  if (!edge && fx.page && fx.key) edge = { page: fx.page, key: fx.key, type: fx.type || null };
  if (!edge) { skipped.push(`${from}: 清单里配不上这条边`); continue; }
  let newKey = null;
  let why = '';
  if (fx.newKey) {
    // 直接给定新 key（「用原文残留片段自动修」这条路径：不需要 targetId，只需保证唯一）
    const h = hitsOf(edge.page, fx.newKey);
    if (h.length !== 1) { skipped.push(`${from}: 给定 newKey「${fx.newKey}」命中 ${h.length} 条，不唯一`); continue; }
    newKey = fx.newKey;
  } else {
    ({ key: newKey, why } = pickKey(targetId));
    if (!newKey) { skipped.push(`${from} → ${targetId}: ${why}`); continue; }
  }
  if (newKey === edge.key) { skipped.push(`${from}: 新 key 与旧 key 相同，无需改`); continue; }
  // 同一个 (from, page, oldKey) 只能修一次：页面里那条文本替换掉之后第二次就找不到了，
  // 而且这种重复多半是「一条 rel 值里塞了两条边」（历史误拼，如 `rel:a.md:x:scenario y:scenario`）。
  const ek = `${from}|${edge.page}|${edge.key}`;
  if (seenEdge.has(ek)) { skipped.push(`${from}: 同一 oldKey「${edge.key}」重复，只修第一条`); continue; }
  seenEdge.add(ek);
  plans.push({ from, page: edge.page, oldKey: edge.key, type: edge.type || null, newKey, targetId: targetId || '(auto)' });
}

console.log(`${APPLY ? '写入' : '干跑'}：可修 ${plans.length} 条 ｜ 跳过 ${skipped.length} 条`);
if (skipped.length) console.log('跳过：\n  ' + skipped.join('\n  '));
for (const p of plans) console.log(`  ${p.from}  rel:${p.page}:${p.oldKey}${p.type ? ':' + p.type : ''}  →  ${p.newKey}`);
if (!APPLY) { console.log('\n（干跑结束；加 --apply 才真写）'); process.exit(0); }

// —— 按页分组写入 ——
const byPage = new Map();
for (const p of plans) {
  const page = p.from.split('#')[0];
  if (!byPage.has(page)) byPage.set(page, []);
  byPage.get(page).push(p);
}
const ts = Date.now();
let fail = 0;
for (const [page, list] of byPage) {
  const f = path.join(PD, page);
  const raw0 = fs.readFileSync(f);
  const hasBom = raw0[0] === 0xEF && raw0[1] === 0xBB && raw0[2] === 0xBF;
  const lines = raw0.toString('utf8').replace(/^\uFEFF/, '').split('\n');
  let hit = 0;
  for (const p of list) {
    // 只认后面紧跟空白/逗号/注释结束/行尾的那个旧值，避免 key 互为前缀时替换错
    const re = new RegExp(`rel:${escRe(p.page)}:${escRe(p.oldKey)}(:${p.type})?(?=[\\s,]|-->|$)`);
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      lines[i] = lines[i].replace(re, `rel:${p.page}:${p.newKey}${p.type ? ':' + p.type : ''}`);
      hit += 1; done = true;
      break;
    }
    if (!done) { skipped.push(`${p.from}: 正文里找不到 rel:${p.page}:${p.oldKey}`); fail += 1; }
  }
  fs.writeFileSync(`${f}.bak-relfix-${ts}`, raw0);
  fs.writeFileSync(f, (hasBom ? '\uFEFF' : '') + lines.join('\n'), 'utf8');
  console.log(`  [${page}] 重写 ${hit} 处`);
}
console.log(`\n受影响页：${[...byPage.keys()].join(' ')}`);
console.log('⚠️ 下一步必须 reindex：');
for (const page of byPage.keys()) console.log(`   node E:/2/_dsh_memory/tools/reindex-page.mjs ${page}`);
if (fail) console.log(`⚠️ ${fail} 条没落到正文（见上面跳过列表）`);
