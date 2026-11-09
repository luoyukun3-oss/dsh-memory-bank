// ============================================================================
// Memory Bank · core-transcript —— 会话日志读取（2026-11-09 从 core.mjs 按域拆出）
//   为什么拆：core.mjs 实测 509/510 行（100%，下一条改动就爆）。按预算表的规矩
//   「超限先按域拆分，别压缩行宽硬塞」—— 本文件装**会话日志这一件事**：
//   多帧 zstd 解压 / 逐行解析 / 日志落点探测 / 按仓库筛会话。
//   ⚠️ 对外**零变化**：core.mjs 用 `export { ... } from "./core-transcript.mjs"` 原样转发，
//      所有 `from "./core.mjs"` 的调用点一个字都不用改。
//   只依赖 node 标准库（fs / path / zlib），不 import core.mjs（避免循环依赖）。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------- 会话日志读取
export const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decompressAll(buffer) {
  const marks = [];
  let i = buffer.indexOf(MAGIC);
  while (i !== -1) { marks.push(i); i = buffer.indexOf(MAGIC, i + 4); }
  if (!marks.length) return zlib.zstdDecompressSync(buffer);
  const parts = [];
  let pos = 0;
  while (pos < marks.length) {
    const end = pos + 1 < marks.length ? marks[pos + 1] : buffer.length;
    try { parts.push(zlib.zstdDecompressSync(buffer.subarray(marks[pos], end))); pos++; continue; } catch {}
    let k = pos + 1, ok = false;
    while (k < marks.length) {
      const e2 = k + 1 < marks.length ? marks[k + 1] : buffer.length;
      try { parts.push(zlib.zstdDecompressSync(buffer.subarray(marks[pos], e2))); pos = k + 1; ok = true; break; } catch { k++; }
    }
    if (!ok) break;
  }
  return Buffer.concat(parts);
}


export function readRecords(transcriptPath) {
  const text = decompressAll(fs.readFileSync(transcriptPath)).toString('utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}


export const textOf = (content) => (content || []).filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();

/** 会话日志可能落在哪些 harness home（2026-09-30 新增官方桌面版的 ~/.dsh）。
 *  起因：旧壳用 %APPDATA%\dsh-desktop\harness，官方版用 ~/.dsh ——
 *  只扫一个根，另一个 App 里的对话就永远进不了记忆库（实测 tick 摄入不到）。 */
export function transcriptHomes(extra) {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (!p) return;
    const norm = path.resolve(p).replace(/[\\/]+$/, '');
    if (seen.has(norm.toLowerCase())) return;
    seen.add(norm.toLowerCase());
    try { if (fs.statSync(norm).isDirectory()) out.push(norm); } catch { /* 不存在就跳过 */ }
  };
  add(process.env.DSH_HOME);
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'dsh-desktop', 'harness'));  // 旧壳 DSH Desktop
  if (process.env.USERPROFILE) add(path.join(process.env.USERPROFILE, '.dsh'));            // 官方 DeepSeek Harness
  for (const p of extra || []) add(p);                                                    // 调用方/测试追加
  return out;
}

/** 在 DSH sessions 目录里找某仓库的会话日志（多根合并，见 transcriptHomes） */

export function findTranscripts(cwd, extraHomes) {
  const slug = `--${path.resolve(cwd).replace(/[:\\]/g, '-').replace(/^-+/, '')}--`.toLowerCase();
  const out = [];
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd')) out.push({ file: p, size: fs.statSync(p).size, mtime: fs.statSync(p).mtimeMs, dirName: path.basename(path.dirname(p)) });
    }
  };
  for (const home of transcriptHomes(extraHomes)) walk(path.join(home, 'sessions'));
  // 目录名形如 --E-2--：优先匹配当前仓库，匹配不到就全部返回（由调用方过滤）
  const matched = out.filter((o) => o.dirName.toLowerCase().includes(slug.replace(/^--|--$/g, '')));
  return (matched.length ? matched : out).sort((a, b) => b.mtime - a.mtime);
}
