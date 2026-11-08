// 自动更新记忆：备份会话日志 + 生成会话摘要 + 刷新工作区状态面板
// 用法：node auto_memory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { listSessionLogs, readSessionRecords, summarize } from './zstd_multi.mjs';

const HOME = process.env.DSH_HOME || path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness');
const SESSIONS_SRC = path.join(HOME, 'sessions');
const ROOT = 'E:/2';
const MEM = path.join(ROOT, '_dsh_memory');
const SESS_DEST = path.join(MEM, 'sessions');
const DIGEST_DIR = path.join(MEM, 'digest');
const STATE_DIR = path.join(MEM, 'state');

for (const d of [SESS_DEST, DIGEST_DIR, STATE_DIR]) fs.mkdirSync(d, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const zh = (ms) => new Date(Number(ms) || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const kb = (bytes) => Math.round(bytes / 102) / 10;

// ---------- 1. 备份会话日志 ----------
const logs = listSessionLogs(SESSIONS_SRC);
const manifest = [];
for (const { file, size } of logs) {
  const sessionDir = path.basename(path.dirname(file));
  const outName = `${sessionDir}__${path.basename(file)}`;
  fs.copyFileSync(file, path.join(SESS_DEST, outName));
  manifest.push({ backupName: outName, source: file, bytes: size, modified: fs.statSync(file).mtime.toISOString() });
}
const totalBytes = manifest.reduce((s, m) => s + m.bytes, 0);
fs.writeFileSync(
  path.join(SESS_DEST, 'manifest-latest.json'),
  JSON.stringify({ backedUpAt: new Date().toISOString(), source: SESSIONS_SRC, fileCount: manifest.length, totalBytes, files: manifest }, null, 2),
  'utf8',
);

// ---------- 2. 给每个会话生成摘要 ----------
const digestLines = [];
const sessionStats = [];
digestLines.push(`# 会话摘要 · ${zh(Date.now())}`);
digestLines.push('');
digestLines.push(`备份自：\`${SESSIONS_SRC}\``);
digestLines.push(`共 ${logs.length} 个会话日志，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
digestLines.push('');
digestLines.push('> 本文件由 `auto_memory.mjs` 自动生成：机械汇总（用户原话、助手回复开头、工具使用统计），**不含语义提炼**。');
digestLines.push('');

for (const { file, size } of logs) {
  let recs = [];
  const dirName = path.basename(path.dirname(file));
  try {
    recs = readSessionRecords(file);
  } catch (e) {
    digestLines.push(`## ${dirName}`, `（解压失败：${e.message}）`, '');
    continue;
  }
  const s = summarize(recs);
  sessionStats.push({
    id: s.id || dirName,
    size,
    records: s.counts.records,
    user: s.counts.userMessages,
    assistant: s.counts.assistantMessages,
    tools: s.counts.toolCalls,
    turns: s.counts.turns,
    start: s.createdAt,
    last: recs[recs.length - 1]?.time,
  });

  digestLines.push(`## 会话 ${s.id || dirName}`);
  digestLines.push(`- 工作目录：\`${s.cwd || '?'}\`　开始：${zh(s.createdAt)}　最后活动：${zh(recs[recs.length - 1]?.time)}`);
  digestLines.push(`- 记录 ${s.counts.records} 条｜用户消息 ${s.counts.userMessages}｜助手回复 ${s.counts.assistantMessages}｜工具调用 ${s.counts.toolCalls}｜完成轮次 ${s.counts.turns}`);
  const toolTop = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join('、');
  if (toolTop) digestLines.push(`- 常用工具：${toolTop}`);
  if (s.titles.length) digestLines.push(`- 会话标题：${s.titles.map((t) => `「${clip(t, 40)}」`).join(' ')}`);
  digestLines.push('');
  digestLines.push('### 用户说过的话（时间顺序，截断 160 字）');
  for (const u of s.users) digestLines.push(`- \`${zh(u.time)}\` ${clip(u.text, 160) || '（空）'}`);
  digestLines.push('');
  digestLines.push('### 助手回复开头（末尾 40 条，各截断 120 字）');
  for (const a of s.assistants.slice(-40)) digestLines.push(`- [轮 ${a.turn}] ${clip(a.text, 120)}`);
  digestLines.push('');
}

fs.writeFileSync(path.join(DIGEST_DIR, `digest-${stamp}.md`), digestLines.join('\n'), 'utf8');
fs.writeFileSync(path.join(DIGEST_DIR, 'latest.md'), digestLines.join('\n'), 'utf8');
fs.writeFileSync(
  path.join(DIGEST_DIR, 'latest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), sessions: sessionStats }, null, 2),
  'utf8',
);

// ---------- 3. 工作区状态面板（顶层文件 + 一级目录汇总，避免刷屏）----------
function scanWorkspace() {
  const files = [];
  const dirs = [];
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (e.name === '_dsh_memory') continue; // 记忆库自身不算
    const p = path.join(ROOT, e.name);
    if (e.isDirectory()) {
      let count = 0;
      let bytes = 0;
      const walk = (d) => {
        for (const x of fs.readdirSync(d, { withFileTypes: true })) {
          const q = path.join(d, x.name);
          if (x.isDirectory()) walk(q);
          else {
            count += 1;
            try {
              bytes += fs.statSync(q).size;
            } catch {}
          }
        }
      };
      try {
        walk(p);
      } catch {}
      dirs.push({ path: `${e.name}/`, files: count, kb: kb(bytes) });
    } else {
      files.push({ path: e.name, kb: kb(fs.statSync(p).size), mtime: fs.statSync(p).mtime.toISOString() });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  dirs.sort((a, b) => a.path.localeCompare(b.path));
  return { files, dirs };
}

const { files, dirs } = scanWorkspace();
const stateFile = path.join(STATE_DIR, 'workspace.json');
const prev = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { files: [], dirs: [] };
const prevFiles = new Map((prev.files || []).map((f) => [f.path, f]));
const curFiles = new Map(files.map((f) => [f.path, f]));
const added = files.filter((f) => !prevFiles.has(f.path));
const removed = (prev.files || []).filter((f) => !curFiles.has(f.path));
const changed = files.filter((f) => {
  const p = prevFiles.get(f.path);
  return p && p.mtime && p.mtime !== f.mtime;
});
const prevDirs = new Map((prev.dirs || []).map((d) => [d.path, d]));
const dirChanges = dirs.filter((d) => {
  const p = prevDirs.get(d.path);
  return !p || p.files !== d.files;
});
fs.writeFileSync(stateFile, JSON.stringify({ scannedAt: new Date().toISOString(), files, dirs }, null, 2), 'utf8');

const status = [];
status.push('# 状态面板（自动生成）');
status.push('');
status.push(`> 由 \`auto_memory.mjs\` 生成于 ${zh(Date.now())}；上次扫描：${prev.scannedAt ? zh(prev.scannedAt) : '（首次）'}`);
status.push('');
status.push('## 会话');
status.push('');
status.push('| 会话 | 记录 | 用户消息 | 助手回复 | 工具调用 | 轮次 | 备份大小 |');
status.push('|---|---|---|---|---|---|---|');
for (const s of sessionStats) {
  status.push(`| \`${(s.id || '').slice(0, 26)}\` | ${s.records} | ${s.user} | ${s.assistant} | ${s.tools} | ${s.turns} | ${(s.size / 1024 / 1024).toFixed(2)} MB |`);
}
status.push('');
status.push('## 顶层文件变化');
status.push('');
status.push(`顶层文件 ${files.length} 个；一级目录 ${dirs.length} 个`);
if (added.length) {
  status.push('', '**新增：**');
  for (const f of added) status.push(`- \`${f.path}\`（${f.kb} KB）`);
}
if (removed.length) {
  status.push('', '**消失：**');
  for (const f of removed) status.push(`- \`${f.path}\``);
}
if (changed.length) {
  status.push('', '**内容有更新：**');
  for (const f of changed) status.push(`- \`${f.path}\`（${f.kb} KB）`);
}
if (dirChanges.length) {
  status.push('', '**目录文件数变化：**');
  for (const d of dirChanges) {
    const p = prevDirs.get(d.path);
    status.push(`- \`${d.path}\` ${p ? `${p.files} → ${d.files}` : `新增目录，${d.files} 个文件`}`);
  }
}
status.push('');
status.push('## 顶层文件清单');
status.push('');
status.push('| 文件 | KB |');
status.push('|---|---|');
for (const f of files) status.push(`| \`${f.path}\` | ${f.kb} |`);
status.push('');
status.push('## 一级目录汇总');
status.push('');
status.push('| 目录 | 文件数 | 合计大小 |');
status.push('|---|---|---|');
for (const d of dirs) status.push(`| \`${d.path}\` | ${d.files} | ${d.kb >= 1024 ? (d.kb / 1024).toFixed(2) + ' MB' : d.kb + ' KB'} |`);
status.push('');
fs.writeFileSync(path.join(MEM, 'STATUS.md'), status.join('\n'), 'utf8');

console.log('自动记忆更新完成：');
console.log(`  备份 ${manifest.length} 个会话日志（${(totalBytes / 1024 / 1024).toFixed(2)} MB）→ _dsh_memory/sessions/`);
console.log(`  生成摘要 → _dsh_memory/digest/latest.md`);
console.log(`  刷新状态 → _dsh_memory/STATUS.md（顶层文件 ${files.length}，新增 ${added.length}，消失 ${removed.length}，更新 ${changed.length}）`);
