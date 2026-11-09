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
import { KINDS } from './page-toc-kinds.mjs';   // 三种页型的渲染器（2026-11-09 按域拆出，纯函数）

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const CHECK = argv.includes('--check');
const ALL = argv.includes('--all');
const REPO = opt('--repo');

const BEGIN_LINE = '<!-- TOC:BEGIN —— 自动生成（_dsh_memory/tools/page-toc.mjs），勿手改 -->';
const END_LINE = '<!-- TOC:END -->';
const BEGIN_RE = /^<!--\s*TOC:BEGIN[\s\S]*?-->\s*$/;
const END_RE = /^<!--\s*TOC:END\s*-->\s*$/;
// —— 2026-11-09 按域拆（本文件当时 221/230 行）——
//   三个渲染器（待办/教训/故障）连同 `SCHED`、`RECENT`、`shorten`、`clean` 搬到
//   `page-toc-kinds.mjs`（纯函数、不碰文件系统），验收契约写在那边头注释。
//   ⇒ 本文件剩下的只有**入口**：argv、去旧块、行号偏移探测、自校验、`.bak-<时间戳>` 备份、写盘。
//   ⚠️ 输出文案与退出行为**一字未改**（`test-toc.mjs` T1/T2 与 `cli tick` 的「N 页已刷新」计数都靠它）。


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
