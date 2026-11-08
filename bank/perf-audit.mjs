// 性能打点 + 内存判据（bank/perf-audit.mjs，2026-09-21）
// ============================================================
// 背景：这是待办「性能与资源治理（借 dsh-pet）」的 ①②。⚠️ **但原始清单已失传** ——
// `todos.md` 里只留下「打点与内存判据照做」一句、细节区没记，`E:\2` 里也没有 dsh-pet
// 的抓取文件（当初读完直接用了，没落盘）。所以 2026-09-21 按**我们自己的场景重新定义**，
// 原则只有一条：**能真的用起来**。
//
//   ① 打点：每次 cli 调用的「命令 + 耗时」。退出时自动记一笔 —— import 即生效、零侵入。
//   ② 内存判据：退出时的 rss / heapUsed 走势。**短命进程只适合看趋势**，
//      所以判据刻意宽松（近 N 次里几乎单调增 **且** 末尾比开头大 50% 才告警），
//      免得把正常的 V8 波动报成"内存泄漏"。
//
// ⚠️ 两条硬约束（都是踩过的坑换来的）：
//   1. **绝不能因为打点失败影响主流程** —— hook 跑在只读沙箱里，写文件会 EPERM
//      （2026-09-15 那次事故：给 recall 加"记一笔访问"，写盘失败抛异常 ⇒ 整个
//      user-prompt 挂掉、一条注入都发不出去）。所以整段包 try/catch **静默跳过**。
//   2. 只被 `cli.mjs` import ⇒ **只有 CLI 调用会被记录**，hook / test 不受影响。
//
// 用法：`node bank/perf-audit.mjs` 直接看报告（不必走 cli）；`cli sweep` 里也会带一段。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MEM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // bank/ → _dsh_memory/
const STATE_DIR = path.join(MEM_ROOT, 'state');
const PERF_FILE = path.join(STATE_DIR, 'perf.json');
const KEEP = 200;          // 只留最近 200 条，别让文件无限长
const MEM_WINDOW = 10;     // 内存判据看最近 10 次

/** 读打点文件；不存在或坏了都当空。 */
function readPerf() {
  try { return JSON.parse(fs.readFileSync(PERF_FILE, 'utf8')); } catch { return { runs: [] }; }
}

/** 原子写（先临时文件再 rename），避免写一半把文件毁了。 */
function writePerf(data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${PERF_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, PERF_FILE);
}

// ── ① 打点：import 即生效，进程退出时记一笔 ────────────────────────────────
const STARTED_AT = Date.now();
const CLI_CMD = process.argv.slice(2).find((a) => !a.startsWith('--')) || '(none)';

process.on('exit', () => {
  try {
    const mem = process.memoryUsage();
    const runs = readPerf().runs;
    const list = Array.isArray(runs) ? runs : [];
    list.push({
      at: new Date().toISOString(),
      cmd: CLI_CMD,
      ms: Date.now() - STARTED_AT,
      rssMB: Math.round(mem.rss / 1048576),
      heapMB: Math.round(mem.heapUsed / 1048576),
    });
    writePerf({ runs: list.slice(-KEEP) });
  } catch {
    // 打点失败一律吞掉：只读沙箱（hook）、磁盘满、权限不足…都不该影响主流程
  }
});

/** 中位数（偶数个取中间两个的均值）。 */
function median(list) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * ② 内存判据：短命进程只看**趋势**。
 * 告警条件刻意严：近 window 次里至少 window-2 次上升，**且** 末尾 ≥ 开头的 1.5 倍。
 * @param runs - 打点记录数组
 * @param window - 观察窗口
 */
function judgeMemory(runs, window = MEM_WINDOW) {
  const list = runs.slice(-window).map((r) => r.rssMB);
  if (list.length < window) return { verdict: `样本不足（${list.length}/${window}）`, list, level: 'unknown' };
  let rises = 0;
  for (let i = 1; i < list.length; i += 1) if (list[i] > list[i - 1]) rises += 1;
  const first = list[0];
  const last = list[list.length - 1];
  const grew = first > 0 ? last / first : 1;
  if (rises >= window - 2 && grew >= 1.5) {
    return { verdict: `⚠️ 疑似持续增长（${first} → ${last} MB，${rises}/${window - 1} 次上升）`, list, level: 'warn' };
  }
  return { verdict: `✅ 无增长趋势（${first} → ${last} MB，上升 ${rises}/${window - 1} 次）`, list, level: 'ok' };
}

/** 汇总：给 sweep 用的报表数据。 */
export function auditPerf() {
  const runs = readPerf().runs;
  const list = Array.isArray(runs) ? runs : [];
  const byCmd = new Map();
  for (const r of list) {
    if (!byCmd.has(r.cmd)) byCmd.set(r.cmd, []);
    byCmd.get(r.cmd).push(r.ms);
  }
  const cmds = [...byCmd.entries()]
    .map(([cmd, ms]) => ({ cmd, n: ms.length, median: median(ms), max: Math.max(...ms) }))
    .sort((a, b) => b.median - a.median);
  const recent = list.slice(-20);
  const slowest = [...recent].sort((a, b) => b.ms - a.ms).slice(0, 3);
  return { total: list.length, cmds, recent, slowest, memory: judgeMemory(list) };
}

/** 打印格式（照 degenerate-audit 的先例：打印留在本模块，cli 只留一行调用）。 */
export function formatPerfReport(p) {
  if (!p.total) return ['⑦ 性能打点：还没有样本（跑几次 cli 就会自动记录）'];
  const top = p.cmds.slice(0, 5).map((c) => `${c.cmd} ${c.median}ms×${c.n}`).join(' ｜ ');
  const slow = p.slowest.map((s) => `${s.cmd} ${s.ms}ms`).join(' ｜ ');
  return [
    `⑦ 性能打点：共 ${p.total} 次 cli 调用（明细 state/perf.json）`,
    `   各命令中位数：${top}`,
    `   最近最慢三次：${slow}`,
    `   内存走势：${p.memory.verdict}`,
  ];
}

// 直接运行：`node bank/perf-audit.mjs` 看完整报告（含逐条明细）
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const p = auditPerf();
  for (const line of formatPerfReport(p)) console.log(line);
  console.log('');
  console.log('最近 15 次明细：');
  for (const r of p.recent.slice(-15)) {
    console.log(`  ${r.at.replace('T', ' ').slice(0, 19)}  ${String(r.cmd).padEnd(9)} ${String(r.ms).padStart(6)}ms  rss=${r.rssMB}MB  heap=${r.heapMB}MB`);
  }
}
