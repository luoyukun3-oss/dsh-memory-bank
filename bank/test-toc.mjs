// ============================================================================
// test-toc.mjs —— 2026-10-05 新增：TOC 注入机制的回归断言（补 test.mjs 事故中丢失的覆盖）
//   覆盖：page-toc 幂等、TOC 行号与真实行号一致、注入只出目录+定时条目、无 TOC 时回退、
//         splitItems 遇 `---` 不归属条目、注入总量不超预算。
// 运行：node bank/test-toc.mjs   （失败时退出码 1；也会被 test.mjs import 时执行）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { splitItems } from './index.mjs';
import { tocInject, indexList } from './inject-index.mjs';
import { INJECT_BUDGET } from './config-keys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..');
const REPO = path.join(MEM, 'repos', 'e-2');
const TODOS = path.join(REPO, 'pages', 'todos.md');
const TOOL = path.join(MEM, 'tools', 'page-toc.mjs');
const CLI = path.join(HERE, 'cli.mjs');

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  [OK] ' + msg); } else { fail++; console.log('  [!!] ' + msg + (extra ? '  -> ' + extra : '')); }
};

console.log('== T1. page-toc 幂等（再跑一次应报「最新/无需改动」）==');
{
  const r = spawnSync(process.execPath, [TOOL, '--check', '--all'], { encoding: 'utf8' });
  const out = String(r.stdout || '');
  ok(r.status === 0, 'page-toc --check 正常退出', 'exit=' + r.status);
  ok(!/已过期/.test(out), '三个知识页目录都是最新的（过期时说明 todos/lessons/faults 改了没刷）', out.trim().replace(/\n/g, ' | ').slice(0, 160));
}

console.log('== T2. TOC 里的行号 = 正文真实行号 ==');
{
  const lines = fs.readFileSync(TODOS, 'utf8').split('\n');
  const b = lines.findIndex((l) => /TOC:BEGIN/.test(l));
  const e = lines.findIndex((l) => /TOC:END/.test(l));
  ok(b >= 0 && e > b, 'todos.md 有 TOC 块', `b=${b + 1} e=${e + 1}`);
  const tocLines = lines.slice(b + 1, e);
  // 抽 TOC 里第一条带 L 行号的条目标题，回到正文核对
  const m = tocLines.map((l) => /L(\d+)/.exec(l)).find(Boolean);
  if (!m) { ok(false, 'TOC 里能找到行号标记'); } else {
    const n = Number(m[1]);
    const target = String(lines[n - 1] || '');
    ok(/^\s*[-*]\s/.test(target) || /^\s*\|/.test(target), `TOC 标的 L${n} 确实是一条待办/表格行`, target.slice(0, 60));
  }
  // 每行 TOC 都以 `> ` 开头（保证任何"跳过引用块"的解析器都不会误收）
  ok(tocLines.every((l) => l.trim() === '' || l.trim().startsWith('>')), 'TOC 块每行都以 > 开头（解析器安全）');
}

console.log('== T3. 注入只出「目录 + 定时条目」，不出长正文 ==');
{
  const text = fs.readFileSync(TODOS, 'utf8');
  const injected = indexList(text);
  ok(injected.length > 0, '待办注入非空');
  ok(/⏰|定时/.test(injected), '注入里标出了定时条目');
  ok(/\[at:|\[\d{1,2}:\d{2}\]/.test(injected) || /\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(injected), '定时条目的时间出现在注入里');
  ok(injected.replace(/\s/g, '').length < 1200, '待办注入压缩后 < 1200 字（软配额 600 附近）', injected.replace(/\s/g, '').length + ' 字');
  // 长正文（某条待办的第 300 字之后的内容）不应出现在注入里
  const longItem = (text.split('\n').find((l) => /^- \[ \].{200,}/.test(l)) || '').slice(200, 260);
  if (longItem) ok(!injected.includes(longItem), '注入里不含待办的长正文（只给目录）');
}

console.log('== T4. 没有 TOC 块时回退到逐条索引 ==');
{
  const noToc = '- [ ] 甲任务：说明\n- [ ] 乙任务：说明\n';
  const out = indexList(noToc);
  ok(/甲任务/.test(out) && /乙任务/.test(out), '无 TOC 块时仍能逐条列出（向后兼容）');
  ok(tocInject(noToc) === '', 'tocInject 对没有 TOC 的文本返回空串（触发回退）');
}

console.log('== T5. splitItems：独立 --- 不归属任何条目 ==');
{
  const body = '## 其他待办\n- [ ] 甲：说明\n  （续行）\n\n---\n\n> 细节备查\n- 这里的内容不该进条目\n';
  const items = splitItems('其他待办', body);
  const allText = items.map((i) => i.text).join('\n');
  ok(!allText.includes('---'), '条目文本里不含独立 ---（原 bug：被上一条吞掉）', allText.slice(0, 80));
  ok(!/细节备查/.test(allText), '--- 之后的细节区不进任何条目');
  ok(items.some((i) => /甲/.test(i.title)), '正常条目仍被切出来');
}

console.log('== T6. 注入总量不超总预算 ==');
{
  const r = spawnSync(process.execPath, [CLI, 'preview'], { encoding: 'utf8' });
  const m = /（(\d+)\s*字）/.exec(String(r.stdout || ''));
  const n = m ? Number(m[1]) : 0;
  ok(n > 0 && n <= INJECT_BUDGET, `注入总量 ${n} ≤ 预算 ${INJECT_BUDGET}`, '解析到 ' + n);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
