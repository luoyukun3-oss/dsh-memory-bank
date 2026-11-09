// Memory Bank · tick 的写操作日志（2026-11-08）。
//
// 起因（笔记第四轮 14.1「写操作日志 memory_write_ops 式：tick 的每一步记 status/step，崩了能续」）：
//   commands/tick.mjs 的 step() 一直把每段 {name, ms, ok, err, skipped} 推进 marks，
//   但 marks **只被 log() 打到屏幕**，从不落盘 ⇒ 进程被杀/崩溃，那次的执行痕迹随屏幕一起消失，
//   下一轮也无从知道「上次卡在哪一段」。本模块补这一环 —— **只做观测，不改任何段的执行语义**。
//
// 两件事：
//   ① writeTickLog：段一结束就增量覆盖写 repos/<slug>/state/tick-last.json（done:false），
//      收尾时再写一份 done:true ⇒ 崩掉时磁盘上正好停在「最后一个跑完的段」，一眼看出卡在它之后；
//   ② logLastTick：tick 开头把上一轮记录读回来压成一行；`cli tick --last` 走 verbose 逐段列。
//
// ⚠️ 约定（同 sweep-stamp.json / handoff-stamp.json）：**记账模块不该拖垮收尾流程** ——
//   所有 IO 包在 try/catch 里，写不进去就静默跳过；读坏了当没有（返回 null）。
import path from 'node:path';
import { readJson, writeJson } from './core.mjs';

const FILE = 'tick-last.json';
// 路径口径同 commands/tick.mjs 的 `stampFile(dir, name)`（= `<repo>/state/<name>`），
// 和 sweep-stamp / handoff-stamp 并排放，人肉排查时一处就能看全。
const pathOf = (dir) => path.join(dir, 'state', FILE);

/** 读上一轮记录；没有或 JSON 坏了都返回 null（readJson 自带兜底，不抛）。 */
function readLastTick(dir) { return readJson(pathOf(dir), null); }

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** 单段的样子：失败（带原因）> 跳过 > 耗时 —— 口径与原来 tick.mjs 那行 `[分段]` 一致。 */
const oneStep = (m) => (!m.ok
  ? `${m.name} ⚠️${m.err ? '（' + m.err + '）' : ''}`
  : (m.skipped ? `${m.name}·跳过` : `${m.name} ${(m.ms / 1000).toFixed(1)}s`));

/**
 * 落盘一轮快照。`done:false` = 还在跑（或已崩），`done:true` = 正常收尾。
 * 失败静默 —— 账记不下来不能反过来把 tick 弄崩。
 */
export function writeTickLog(dir, { at, quick, steps, done }) {
  try {
    writeJson(pathOf(dir), { at, atIso: stamp(at), quick: !!quick, totalMs: Date.now() - at, done: !!done, steps });
  } catch { /* 写不了就当没这回事，下一轮照写 */ }
}

/**
 * tick 开头读 + 打印上一轮摘要。没有记录时只在 verbose 下说话（免得每轮多一行噪音）。
 * @returns {boolean} 传了 optLast ⇒ 返回 true，表示「只读模式已满足，别再跑任何段」。
 */
export function logLastTick(dir, log, optLast) {
  const rec = readLastTick(dir);
  if (!rec) {
    if (optLast) log('[上次 tick] 还没有落盘记录（state/tick-last.json 不存在）');
    return !!optLast;
  }
  const tail = (rec.steps || []).map(oneStep).join('｜');
  log('[上次 tick] ' + stamp(rec.at) + (rec.quick ? '｜quick' : '｜全量')
    + (rec.done ? '' : '｜⚠️ 未收尾（崩了／被杀，或此刻仍在跑）')
    + '｜合计 ' + ((rec.totalMs || 0) / 1000).toFixed(1) + 's' + (tail ? '｜' + tail : ''));
  if (optLast) {
    // 每段一行（失败那段的原因已由 oneStep 带在 `⚠️（…）` 里，别再重复一遍）
    for (const m of rec.steps || []) log('  ' + (m.ok ? (m.skipped ? '·' : '✅') : '❌') + ' ' + oneStep(m));
    log('  → 文件：' + pathOf(dir) + (rec.done ? '（已正常收尾）' : '（未收尾：可能崩在最后一个 ✅ 之后，或此刻仍在跑）'));
  }
  return !!optLast;
}

/** 收尾：打印分段耗时（原来 tick.mjs 里那 6 行搬过来）+ 落一份 done:true 的终稿。 */
export function finishTickLog(dir, { at, quick, steps }, log) {
  log('[分段] ' + steps.map(oneStep).join('｜') + '｜合计 ' + ((Date.now() - at) / 1000).toFixed(1) + 's');
  writeTickLog(dir, { at, quick, steps, done: true });
}
