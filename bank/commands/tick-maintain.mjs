// ============================================================================
// Memory Bank · commands/tick-maintain —— tick 的「周期维护」段（2026-11-09）
//
// 为什么单独一段：这两件事都是**按天**尺度的，不该跟着 tick 每 30 分钟跑。
//   ① 备份轮转（`cli rotate` 的核心）：删文件，按天攒 —— 实测 lessons.md 10 天攒 69 份 / 36.5 MB；
//      2026-11-09 一次轮转 288 个 / 78.8 MB → 231 个 / 52.2 MB。不自动就会再涨回去。
//   ② 图谱产物刷新：`graph.html` / `star-map.html` 是生成物，会过期
//      （2026-11-09 实测旧产物 docs=2238，当前索引 1104）。
//
// 节流照抄 tick 里 sweep 的 stamp 模式（`state/<name>-stamp.json` + 分钟闸）：
//   · **只有真跑成功才写 stamp** —— 失败那次不算，下次照常重试（同 sweep / handoff 的约定）
//   · 跳过的分支要能被 tick 的 step() 认出来：**两件都跳过**才返回 `skipped: true`
//     （⚠️ 只跑了一件时返回 true 会把「真跑了」误标成「·跳过」—— 与 handoff 的 skipped 数组是同一类坑）
//
// 为什么是 20 小时（1200 分钟）而不是 24：
//   计划任务的触发时刻会漂几秒（实测 :16:05 / :16:07）⇒ 用整 24 小时时，「昨天 21:00 跑过、
//   今天 20:59:50 到点」会被判成跳过，实际变成**隔 48 小时**才跑一次。留 4 小时余量可保证
//   「每天至少一次」，同时 20 小时 > 1 天的一半 ⇒ 不会一天跑两次。这与 sweep 用 55 分钟而不是 60 同一思路。
//
// ⚠️ 任何失败都不许抛给 tick：备份轮转删错比不删更糟，所以
//   · 只处理 `scanBackups` 分出来的**自动产物**（`_bak/` 人工快照永不进名单，见 bak-rotate.mjs 头注释）
//   · 保留规则仍走 bak-rotate 的默认值（每文件最近 10 份 ∪ 30 天内每天最后一份）
//   · `--rotate-dry` 可只预演；`--no-rotate` / `--no-graph` 可单独关掉
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from '../core.mjs';
import { applyRotation, KEEP_DAILY_DAYS, KEEP_PER_FILE, planRotation, scanBackups } from '../bak-rotate.mjs';
import { MEM_ROOT } from '../live.mjs';

/** 备份轮转的最小间隔：20 小时（理由见文件头「为什么是 20 小时」） */
export const ROTATE_EVERY_MIN = 1200;
/** 图谱刷新的最小间隔：20 小时（同上；生成要读全库索引，成本不低） */
export const GRAPH_EVERY_MIN = 1200;

const stampFile = (dir, name) => path.join(dir, 'state', name);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
/** stamp 距今多少分钟；没跑过/读不到 ⇒ Infinity（= 立刻该跑） */
function ageMinutes(dir, name, now = Date.now()) {
  const st = readJson(stampFile(dir, name), {});
  return st.at ? (now - Number(st.at)) / 60000 : Infinity;
}

/** 跑一个渲染工具（默认实现；测试注入假实现以便离线） */
function runToolDefault(tool, repo) {
  const r = spawnSync(process.execPath, [tool, repo], { encoding: 'utf8', timeout: 180000 });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/**
 * tick 的周期维护段：备份轮转 + 图谱刷新，各自带 stamp 节流。
 * @param {{dir:string, opt:Function, log:Function, memRoot?:string, runTool?:Function, now?:number}} ctx
 * @returns {{skipped:boolean, note:string, rotate?:object, graph?:object}}
 */
export function runMaintain({ dir, opt, log, memRoot = MEM_ROOT, runTool = runToolDefault, now = Date.now() }) {
  const parts = [];
  let ran = 0;

  // ① 备份轮转
  let rotate = null;
  if (opt('no-rotate')) parts.push('轮转：关闭');
  else {
    const age = ageMinutes(dir, 'rotate-stamp.json', now);
    if (age < ROTATE_EVERY_MIN) parts.push('轮转：跳过（' + Math.round(age) + ' 分钟前跑过）');
    else {
      const apply = !opt('rotate-dry');
      const { auto, manual } = scanBackups(memRoot);
      const plan = planRotation(auto, {
        keepPerFile: Number(opt('keep', KEEP_PER_FILE)) || KEEP_PER_FILE,
        keepDailyDays: Number(opt('keep-days', KEEP_DAILY_DAYS)) || KEEP_DAILY_DAYS,
        now,   // ⚠️ 必须穿透：否则"每天最后一份"的 30 天窗口用的是真实时钟，与 stamp 判据不同源
      });
      const res = apply ? applyRotation(plan, { apply: true }) : { deleted: 0, bytes: 0 };
      rotate = { auto: auto.length, manual: manual.length, planned: plan.del.length, deleted: res.deleted, bytes: res.bytes, apply };
      // 只有真跑过才写 stamp（dry 也写：它同样"跑过了"，否则 dry 每次都会重算全库扫描）
      try { writeJson(stampFile(dir, 'rotate-stamp.json'), { at: now, ...rotate }); } catch { /* 写不了就下次重跑 */ }
      ran += 1;
      parts.push('轮转：' + (apply
        ? '删 ' + res.deleted + ' 个 / ' + mb(res.bytes) + ' MB（自动产物 ' + auto.length + ' → 保留 ' + plan.keep.length + '）'
        : '预演将删 ' + plan.del.length + ' 个'));
    }
  }

  // ② 图谱产物刷新（graph.html + star-map.html）
  let graph = null;
  if (opt('no-graph')) parts.push('图谱：关闭');
  else {
    const age = ageMinutes(dir, 'graph-stamp.json', now);
    if (age < GRAPH_EVERY_MIN) parts.push('图谱：跳过（' + Math.round(age) + ' 分钟前刷过）');
    else {
      const toolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools');
      const jobs = ['graph-render.mjs', 'star-map.mjs'];
      const done = [];
      const bad = [];
      for (const name of jobs) {
        const tool = path.join(toolsDir, name);
        if (!fs.existsSync(tool)) { bad.push(name + ' 不存在'); continue; }
        let r;
        try { r = runTool(tool, dir); } catch (e) { bad.push(name + ' 抛错：' + String(e && e.message).slice(0, 60)); continue; }
        if (r && r.status === 0) done.push(name.replace('.mjs', '')); else bad.push(name + ' 退出码 ' + (r ? r.status : '?'));
      }
      graph = { ok: !bad.length, done, bad };
      // 全部成功才写 stamp —— 有一个失败就下次重试（同"只有真跑过才写"的规矩）
      if (!bad.length) { try { writeJson(stampFile(dir, 'graph-stamp.json'), { at: now, done }); } catch { /* 同上 */ } }
      // 只要**尝试过**就算跑了（成功失败都算）—— 否则一次失败会被 step() 标成「·跳过」，
      // 把 "⚠️ 退出码 1" 这类真问题藏起来。skipped 只表示"因为节流没动"。
      if (done.length || bad.length) ran += 1;
      parts.push('图谱：' + (bad.length
        ? '⚠️ ' + bad.join('；') + (done.length ? '（已刷 ' + done.join('+') + '）' : '')
        : '已刷新 ' + done.join('+ ')));
    }
  }

  const note = parts.length ? '｜维护：' + parts.join('、') : '';
  // 不单独打日志：`note` 由 tick 拼进汇总行（2026-11-09 实测发现单打会与汇总行重复）。
  // `log` 参数保留在签名里，方便将来要给某一段单独输出时不必改调用点。
  return { skipped: ran === 0, note, rotate, graph };
}

// ---------------------------------------------------------------- 旧版记忆库（2026-10-23 起在 tick 里兜底）
/** 旧版记忆库刷新（从 tick.mjs 搬来，2026-11-09：tick.mjs 189/190 只剩 1 行余量，先拆再接线）。
 *  ⚠️ 判据：读**它自己的产物** `state/last_run.log` 的 mtime —— 计划任务 `DSH-Memory-Backup`
 *     每 PT6H 跑同一个 auto_memory.mjs（实测 104 秒），它刚跑过就不重复；
 *     哪天那个任务停了、日志超过 LEGACY_EVERY_MIN ⇒ tick 自己兜底跑（异步，不等待）。
 *  ⚠️ 改计划任务参数要管理员权限（2026-10-23 实测 Set-ScheduledTask/schtasks 双双 Access denied）⇒ 判据只能放代码里。 */
export const LEGACY_EVERY_MIN = 360;
export function runLegacyRefresh({ opt, log, legacyScript = 'E:/2/_dsh_memory/auto_memory.mjs', logFile = 'E:/2/_dsh_memory/state/last_run.log', now = Date.now() }) {
  if (opt('no-legacy')) return { skipped: true };
  let ageMin = Infinity;
  try { ageMin = (now - fs.statSync(logFile).mtimeMs) / 60000; } catch { /* 没跑过 ⇒ 照跑 */ }
  if (ageMin < LEGACY_EVERY_MIN) {
    log(`[记忆银行] 旧版记忆库：跳过（${Math.round(ageMin)} 分钟前刚被 DSH-Memory-Backup 刷过）`);
    return { skipped: true, ageMin };
  }
  try {
    if (fs.existsSync(legacyScript)) {
      const c = spawn(process.execPath, [legacyScript], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      c.on('exit', () => log('[记忆银行] 旧版记忆库已刷新'));
      return { skipped: false, spawned: true };
    }
  } catch { /* 旧库刷新失败不拖垮 tick */ }
  return { skipped: false, spawned: false };
}
