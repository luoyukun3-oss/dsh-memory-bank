// DSH 内核运行期探测：内核**何时加载**、以及 zh_pro **热挂载过哪些插件**。
// ============================================================
// 为什么独立成模块（2026-09-19）：`patch-status.mjs` 已 88% 逼近行数预算，而「探测系统状态」与
//   「审计并打印报告」本就是两件事；拆开之后两个判据也各自可单测。
//
// ⚠️ 两条判据都是用**假阴性**换来的，别再走回头路：
//   ① **内核加载时刻 ≠ Electron 启动时刻**。Electron 单实例锁 `lockfile` 的 mtime 只在主进程
//      启动时更新，而**内核能独立重启** —— 实测 10:23 内核重载、lockfile 仍停在 07:44，
//      当时拿 lockfile 当判据，把**已经生效**的补丁报成了"未生效"。
//   ② **bundles 里有 ≠ 已加载**。bundles 只证明"声明过"；真正的加载证据是 zh_pro 写进
//      `harness.log` 的 `热挂载: <包名>`（实测 `pnpm add` 后 **4 秒**就出现）。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';

/** harness.log 路径。 */
export const logPath = () => path.join(process.env.APPDATA, 'dsh-desktop', 'logs', 'harness.log');

/** profile 的 package.json（`dsh.profile.bundles` 声明的所在地）。 */
export const profilePackageJson = () => (process.env.APPDATA
  ? path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web', 'package.json') : null);

/** 读 harness.log 全文；读不到返回 null —— **不推测**。 */
function readLog() {
  try { return fs.readFileSync(logPath(), 'utf8'); } catch { return null; }
}

/**
 * 内核加载时刻：harness.log 里**最后一次** `DSH entry loaded` 的时间戳。
 * 日志读不到时降级用 lockfile —— 降级会**低估**，所以只会误报"未生效"，方向是安全的。
 * @returns {{at:number, file:string, src:string}|null} null = 完全判不了（不猜）
 */
export function readKernelBoot() {
  const text = readLog();
  if (text !== null) {
    const hits = [...text.matchAll(/\[(\S+Z)\][^\n]*DSH entry loaded/g)];
    if (hits.length) return { at: Date.parse(hits[hits.length - 1][1]), file: logPath(), src: 'harness.log' };
  }
  const guesses = [];
  if (process.env.DSH_HOME) guesses.push(path.join(process.env.DSH_HOME, '..', 'lockfile'));
  if (process.env.APPDATA) guesses.push(path.join(process.env.APPDATA, 'dsh-desktop', 'lockfile'));
  for (const g of guesses) {
    try { return { at: fs.statSync(g).mtimeMs, file: g, src: 'lockfile（降级）' }; } catch { /* 试下一个 */ }
  }
  return null;
}

/**
 * zh_pro 的**热挂载记录**：包名 → 最后一次挂载时间戳。
 * 这是"插件真的被加载了"的直接证据（bundles 只能证明"声明过"）。
 * @returns {Map<string, number>|null} 日志读不到返回 null
 */
export function readHotMounts() {
  const text = readLog();
  if (text === null) return null;
  const out = new Map();
  for (const m of text.matchAll(/\[(\S+Z)\][^\n]*热挂载[:：]\s*(\S+)/g)) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at)) out.set(m[2].trim(), at);
  }
  return out;
}
