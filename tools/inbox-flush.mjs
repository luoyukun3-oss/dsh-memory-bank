#!/usr/bin/env node
// inbox 出队工具 —— 把「已判断消化完」的候选从待整理队列移出，并把指纹记进 discarded.json。
//
// 为什么需要工具化（而不是每次手改两个文件）：
//   出队要**同时**动两个地方，漏一个就出问题 ——
//     ① 从 `inbox.md` 删掉候选行（队列必须有进有出，否则沉积成"伪知识"）
//     ② 把候选指纹写进 `discarded.json`（否则 `ingest --full` 会把同一批原样重灌回来，
//        2026-09-17 实测重灌 19 条、14 条是提问）
//   而指纹算法必须和 `ingest` **完全一致** —— 所以直接 import bank.mjs 的 `fingerprint`，
//   不在这里另写一份（两处算法漂移过：第一版正则写 `\[[a-z]+\.md\]`，真实前缀是 `[todos]`）。
//
// 用法：
//   node inbox-flush.mjs "本次理由"            # 预演：列出将出队的条目 + 将写入的指纹
//   node inbox-flush.mjs "本次理由" --apply     # 真正出队（自动备份两个文件到 _bak/）
//
// ⚠️ 「已消化」这个判断由助手做（读 inbox 内容 → 确认每条都已落地或已答）—— 工具不替你做判断。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from '../bank/bank.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAK_DIR = path.join(HERE, '_bak');
const REPO = path.join(HERE, '..', 'repos', 'e-2');
const INBOX = path.join(REPO, 'pages', 'inbox.md');
const DISCARDED = path.join(REPO, 'discarded.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const reason = argv.filter((a) => !a.startsWith('--')).join(' ').trim() || '未写理由';

const d = new Date();
const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

if (!fs.existsSync(INBOX)) {
  console.error(`✗ 找不到 ${INBOX}`);
  process.exit(2);
}

const raw = fs.readFileSync(INBOX, 'utf8');
const NL = raw.includes('\r\n') ? '\r\n' : '\n';

// 待整理条目 = 顶格 `- ` 开头的行（`> ` 引用块里的历史记录不算）
const items = raw
  .split(/\r?\n/)
  .filter((l) => /^-\s/.test(l))
  .map((l) => l.replace(/^-\s*/, '').trim())
  .filter(Boolean);

if (!items.length) {
  console.log('• inbox 已经是空的，无需出队。');
  process.exit(0);
}

const fps = items.map((it) => fingerprint(it));

console.log(`待出队 ${items.length} 条：${NL}`);
for (let i = 0; i < items.length; i++) {
  console.log(`  ${i + 1}. ${items[i].slice(0, 70)}`);
  console.log(`     指纹: ${fps[i]}`);
}
console.log(`${NL}理由：${reason}`);

if (!APPLY) {
  console.log(`${NL}• 预演模式，未改动任何文件。加 --apply 才真正出队。`);
  process.exit(0);
}

// —— 备份 ——
fs.mkdirSync(BAK_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(BAK_DIR, `inbox.md.bak-${stamp}`), raw, 'utf8');
if (fs.existsSync(DISCARDED)) {
  fs.copyFileSync(DISCARDED, path.join(BAK_DIR, `discarded.json.bak-${stamp}`));
}

// —— ① 指纹写进 discarded.json（去重后追加）——
const disc = fs.existsSync(DISCARDED)
  ? JSON.parse(fs.readFileSync(DISCARDED, 'utf8'))
  : { items: [] };
const have = new Set(disc.items || []);
let addedN = 0;
for (const f of fps) {
  if (!have.has(f)) {
    have.add(f);
    addedN++;
  }
}
disc.items = [...have];
fs.writeFileSync(DISCARDED, JSON.stringify(disc, null, 2) + NL, 'utf8');

// —— ② 从 inbox.md 删掉候选行，并在历史记录里留一条 ——
let out = raw.replace(/^-\s.*(\r?\n)?/gm, '');
out = out.replace(/(\r?\n){3,}/g, NL + NL);

const anchor = `> **历史清理记录（倒序）**${NL}>${NL}`;
if (out.includes(anchor)) {
  const record = `> **${day} 清空**（${items.length} 条）：${reason}`;
  out = out.replace(anchor, `${anchor}${record}${NL}>${NL}`);
} else {
  out = out.replace(/\s*$/, '') + `${NL}${NL}> **${day} 清空**（${items.length} 条）：${reason}${NL}`;
}

fs.writeFileSync(INBOX, out, 'utf8');

console.log(`${NL}✓ 已出队 ${items.length} 条（discarded.json 新增指纹 ${addedN} 个，去重后共 ${disc.items.length} 个）`);
console.log(`✓ 备份在 _bak/：inbox.md.bak-${stamp}`);
