/**
 * 死机制盘点 —— 借自 dsh-pet 的做法：「**死机制清理要逐项 grep 零消费证据**」。
 *
 * 两轮判据（只看一轮会误判，实测踩过）：
 *   ① **外部零引用**：仓库内没有别的文件提到这个导出名；
 *   ② **本文件内也只有定义那一处**：连自己都不用 ⇒ 才算**真死**。
 *   ⚠️ 2026-09-19 实测：`hits = 0` 的 20 个符号里，**19 个只是「多余 export」**
 *   （文件内部还在用，只是不该对外），真死的只有 `BANK_PATHS` 一个。
 *   ⇒ **判据必须两轮，否则会误删。**
 *
 * 本模块**刻意不进 test.mjs 的硬断言**：因为「真死」的最后一步要人判断
 * （可能是留给外部的 API、或计划中的用法），自动判红会变成假警报。
 * 它只负责**列出证据**，用法：`node bank/cli.mjs dead`。
 *
 * 零依赖：只用 node 内置 + 同目录的 dep-audit（复用它的文件枚举）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModules } from './dep-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.dirname(HERE);

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * 盘点所有导出符号的消费证据。
 * @param root - 扫描根目录（默认 _dsh_memory）。
 * @returns 文件数、符号总数、真死清单、多余 export 清单。
 */
export function auditDeadExports(root = MEM) {
  const files = listModules(root);
  const src = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const found = [];
  for (const [f, s] of src) {
    for (const m of s.matchAll(EXPORT_RE)) found.push({ file: f, name: m[1] });
  }
  const rows = found.map(({ file, name }) => {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let outer = 0;
    const where = [];
    for (const [f, s] of src) {
      if (f === file) continue;
      const n = (s.match(re) || []).length;
      if (n) {
        outer += n;
        where.push(path.relative(root, f).replace(/\\/g, '/'));
      }
    }
    const inner = (src.get(file).match(re) || []).length;
    return {
      name,
      file: path.relative(root, file).replace(/\\/g, '/'),
      outer,
      inner,
      where,
      verdict: outer > 0 ? 'ok' : inner <= 1 ? 'dead' : 'over-export',
    };
  });
  rows.sort((a, b) => a.outer - b.outer || a.name.localeCompare(b.name));
  return {
    files: files.length,
    total: rows.length,
    dead: rows.filter((r) => r.verdict === 'dead'),
    overExported: rows.filter((r) => r.verdict === 'over-export'),
  };
}

/**
 * 格式化盘点报告。
 * @param r - auditDeadExports 的返回值。
 * @returns 可打印的多行文本。
 */
export function formatDeadReport(r) {
  const out = [`扫了 ${r.files} 个源文件、${r.total} 个导出符号`];
  if (r.dead.length === 0) {
    out.push('✅ 没有真死机制（外部零引用 且 本文件也不用）');
  } else {
    out.push(`❌ 真死机制 ${r.dead.length} 个 —— 外部零引用、自己也不用，可安全删除：`);
    for (const d of r.dead) out.push(`   ${d.name}   (${d.file})`);
  }
  out.push(`ℹ️ 多余 export ${r.overExported.length} 个（文件内部在用，只是不必对外；删 export 关键字即可收窄可见面）`);
  for (const d of r.overExported.slice(0, 10)) out.push(`   ${d.name}   (${d.file}，内部 ${d.inner} 次)`);
  if (r.overExported.length > 10) out.push(`   …另有 ${r.overExported.length - 10} 个`);
  return out.join('\n');
}
