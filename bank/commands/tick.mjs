// Memory Bank · tick 子命令（2026-10-23 从 cli.mjs **按域拆出**，并按实测重做调度）。
//
// 为什么拆：cli.mjs 实测 489/510（96%），它自己早就记下欠账「下次加命令前先按域拆」
// （先例：commands/mood.mjs / commands/dream-inbox.mjs）。本轮要把 tick 从「一大段裸调用」
// 改成「分段执行」，加代码之前先搬出去。
//
// 为什么重做：2026-10-23 逐段实测（每段单独跑一次，同一台机器同一个库）——
//   ingest 6.3s｜handoff 5.4s｜reflect 2.2s｜tidy 0.4s｜sweep 14.7s｜sync 0.26s
//   page-toc 0.24s｜dream 0.48s｜dream-inbox 0.26s｜legacy(auto_memory) **104s**
// 而计划任务每 30 分钟跑一次（--no-legacy，实测 20 秒/次）⇒ 一天烧掉约 16 分钟 CPU，
// 其中**绝大多数是重复劳动**：handoff 每 30 分钟重解压同一份没变的日志（47/48 次白干），
// sweep 每 30 分钟重算 1102 条文档的 O(n²) 重复检测。
//
// 本轮三件事（都不改产出语义，只改「多久算一次」与「出错怎么收场」）：
//   ① 每段包一层 step()：计时 + try/catch ⇒ 一段抛错不再让后面全不跑（原实现里
//      ingest/handoff/reflect/tidy/sweep/sync/dream 全裸调用，前一段崩了就全停）；
//   ② sweep 带 stamp：距今不到 SWEEP_EVERY_MIN 分钟就跳过（体检不需要每 30 分钟一次）；
//   ③ handoff 的 stamp 在 handoff.mjs 内做（那边才判得出「上一个会话变没变」），
//      tick 只是受益方；`cli handoff --force` 可强制重算。
//
// ⚠️ 约定：本文件**不 import cli.mjs**（避免循环依赖），只接 cli 传进来的上下文
//    （opt / dir / cwd / log）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// ⚠️ 依赖方向照 cli.mjs 原样：**聚合层 bank.mjs 只提供通用能力**，dream / handoff / day-split
//   这三个域模块各自直连 —— 它们没被 bank.mjs re-export（2026-10-23 第一次写时栽在这：
//   `does not provide an export named 'findDreamPairs'`，因为那份清单只覆盖 core/search/bank 自身）。
import { day, ingest, readJson, reflect, sweepRepo, syncFromMemory, tidyRepo, writeJson } from '../bank.mjs';
import { pruneLive } from '../live.mjs';   // ④b 清过期会话状态（2026-10-29：原实现是死代码，从无调用点）
import { writeHandoff } from '../handoff.mjs';
import { findDreamPairs, formatDreamReport } from '../dream.mjs';
import { ingestCandidates } from '../dream-inbox.mjs';
import { writeDaySplit } from './day-split.mjs';
import { tickEnergy } from '../mood.mjs';   // 每轮收尾的能量微调（2026-10-26）
import { autoLogEvent } from '../ev-autolog.mjs';   // 每轮自动记一条事件（2026-10-26）

/** sweep（体检）的最小间隔：默认 55 分钟 —— tick 每 30 分钟一次，55 让它「隔一次跑一次」。
 *  为什么不是 60：计划任务的触发时刻会漂几秒（实测 :16:05 / :16:07），60 会把「刚好 59 分」判成跳过。 */
const SWEEP_EVERY_MIN = 55;

const stampFile = (dir, name) => path.join(dir, 'state', name);

/**
 * 执行一次 tick：增量摄入 → 交接 → 反思 → 整理 → 体检 → 主干同步 → 目录 → 做梦 → 旧库。
 * @param {{opt:Function, dir:string, cwd:string, log:Function}} ctx
 */
export function runTickCommand({ opt, dir, cwd, log }) {
  const t0 = Date.now();
  const marks = [];
  /** 包一段：计时 + 失败隔离。**失败不抛出**，只记进 marks 并让返回值走兜底。 */
  const step = (name, fn) => {
    const s = Date.now();
    let out = null;
    let err = null;
    try { out = fn(); } catch (e) { err = e; }
    marks.push({
      name, ms: Date.now() - s, ok: !err,
      err: err ? String(err.message || err).slice(0, 80) : null,
      // ⚠️ 必须是 `=== true`：handoff 正常返回里也带一个叫 `skipped` 的**数组**（被跳过的候选名单），
      //    而 JS 里空数组是 truthy ⇒ 用 !! 判定会把「真跑了 5 秒」误标成「·跳过」（2026-10-23 当场栽）。
      skipped: !!(out && out.skipped === true),
    });
    return out;
  };

  // quick 模式（2026-10-23 新增，给「每轮收尾自动刷新」用）：只跑 ingest + handoff。
  // 全量 tick 约 20 s（不含 legacy 的 104 s），每轮跑会把 CPU 吃光；而「实时」真正需要的
  // 只有「把这一轮的对话落进 journal」+「交接快照别过期」，其它段落都是按小时/按天尺度的事。
  const quick = !!opt('quick');

  // ① 摄入：会话流水 → journal/pages（`--full` 从零重读）
  const r1 = step('ingest', () => ingest(dir, { cwd, full: !!opt('full') })) || { added: 0, sessions: 0 };
  // ② 交接：必须在 ingest 之后（它读「上一个」会话日志；见 handoff.mjs 头注释）
  const rh = step('handoff', () => writeHandoff(dir, { cwd })) || { ok: false, reason: '本段失败' };
  // ②b 能量：每轮 −2，距上次满 30 分钟每半时 +5（2026-10-26 用户要的「接进每轮收尾」）。
  //      它**不走 setMood**（能量不是气氛，不该要证据/理由），只碰 current.energy。
  //      quick 模式照跑 —— 这正是 quick 存在的意义（每轮一次）。
  const re = step('energy', () => tickEnergy(dir)) || {};
  // ②c 事件：把最近一轮抽成一条原始事件写进 SQLite（2026-10-26，治「事件根本没记」这个洞）。
  //      只记原始事实（用户原话首 60 字 + 工具名），不做摘要 —— 规则做不了"理解"，硬做会造假因果。
  const rv = step('ev', () => autoLogEvent(dir, { cwd })) || {};
  // ③ 反思：写当天 reflections/（quick 跳过 —— 它是「今天的段子」，不需要每轮重写）
  const r2 = quick ? { file: '(quick)' } : (step('reflect', () => reflect(dir, { days: Number(opt('days', 7)) })) || { file: '（失败）' });
  // ④ 整理：归档已完成待办（quick 跳过 —— 归档是整理动作，不是实时性动作）
  const r3 = quick ? { skipped: true } : (step('tidy', () => (opt('no-tidy') ? { skipped: true } : tidyRepo(dir))) || { skipped: true });
  // ④b 清 live：过期会话状态。`pruneLive` 2026-10-26 就写好了，却**从没有调用点** ⇒
  //      live/ 攒到 220 个文件（最早 25 天前）、每轮 readLive 都要 stat 一遍全部。
  //      quick 也跑：这是清理，不是「整理动作」，不该等 tick 全量。
  //      ⚠️ pruneLive 只删带 `sessionId` 的会话状态，目录里别的功能的数据（handoff-state.json 等）不碰。
  const rp = step('live', () => ({ removed: pruneLive() })) || {};
  // ⑤ 体检：**带 stamp 的频率闸**（见文件头 ②）。跳过的分支要返回 skipped:true
  const r4 = quick ? { skipped: true } : (step('sweep', () => {
    if (opt('force-sweep')) return sweepRepo(dir, { apply: false });
    const st = readJson(stampFile(dir, 'sweep-stamp.json'), {});
    const ageMin = st.at ? (Date.now() - Number(st.at)) / 60000 : Infinity;
    if (ageMin < SWEEP_EVERY_MIN) return { skipped: true, ageMin: Math.round(ageMin) };
    const r = sweepRepo(dir, { apply: false });
    // 只有真跑过才写 stamp —— 失败的那次不算（下次照常重试）
    try { writeJson(stampFile(dir, 'sweep-stamp.json'), { at: Date.now(), dupes: (r.dupes || []).length }); } catch { /* 写不了就下次重跑，不影响正确性 */ }
    return r;
  }) || { skipped: true });
  // ⑥ 主干同步（2026-09-21 用户拍板：tick 常驻报告，漂移不再等「有人想起跑 sync」）
  const r5 = quick ? { ok: true, drift: 0 } : (step('sync', () => syncFromMemory(dir, { apply: false })) || { ok: false, drift: 0 });
  // ⑦ 目录刷新（todos.md 一变，顶部 TOC 的行号就会漂）
  const r6 = quick ? {} : (step('toc', () => {
    const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'page-toc.mjs');
    if (!fs.existsSync(tool)) return {};
    const r = spawnSync(process.execPath, [tool, '--all', '--repo', dir], { encoding: 'utf8' });
    const changed = String(r.stdout || '').trim().split('\n').filter((x) => x.includes('已刷新')).length;
    return { note: '｜知识页目录：' + (r.status === 0 ? (changed ? changed + ' 页已刷新' : '最新') : '⚠️ 刷新失败') };
  }) || {});

  // 汇总行（保持 2026-09-21 起的格式：test-mechanisms 第 18 节有断言守着「主干同步」这一段）
  const sweepNote = quick
    ? '体检：跳过（quick）'
    : (r4.skipped
      ? '体检：跳过（' + (r4.ageMin === undefined ? '本段失败' : r4.ageMin + ' 分钟前刚跑过') + '）'
      : '体检：注入 ' + r4.injectChars + '/' + r4.budget + '（余量 ' + r4.headroom + '）、重复 '
        + r4.dupes.length + ' 对、退役候选 ' + r4.lowValue.length + ' 条、inbox ' + r4.inbox.items + ' 条');
  log('[记忆银行] 摄入 +' + r1.added + ' 条（会话 ' + r1.sessions + ' 个）｜反思 ' + path.basename(String(r2.file))
    + (rh.ok ? '｜交接 ' + rh.turns + ' 轮/' + rh.chars + ' 字' : '｜交接：跳过（' + rh.reason + '）')
    + (r3.skipped ? '' : '｜整理：归档已完成 ' + r3.moved + ' 条、剩未完成 ' + r3.open + ' 条')
    + (rp.removed ? '｜清 live：' + rp.removed + ' 个过期会话状态' : '')
    + '｜' + sweepNote
    + '｜主干同步：' + (r5.ok ? (r5.drift ? '⚠️ ' + r5.drift + ' 处不一致（跑 sync 看详情）' : '一致') : '（找不到 MEMORY.md）')
    + (r6.note || ''));

  // ⑧ 联想收件箱（2026-10-18 用户拍板方案 A：收件箱 + 定时拉子代理审批）
  // quick 模式跳过：做梦/收件箱/按天页都是「每天一次」尺度的事，每轮跑纯属浪费。
  // ⚠️ 2026-11-01 用户令「改成实时链接 + 定时全库扫描」—— 修「收件箱好几天不进新」的根因：
  //   实测（11-01）默认档 farList 恒 0：1046 组原始对 → 枢纽页/索引条目过滤后 kept=40
  //   → 这 40 组**全部** dayGap ∈ {0,2}（同日/相邻）⇒ 默认档一组不进，收件箱自 10-18 起只剩 1 条。
  //   ⇒ 改成吃 near 档（= kept 全集），但**只把高重叠的送进收件箱**（INBOX_MIN_OVERLAP），
  //     否则 40 组低价值同日对会重演 10-18「61 组全判 no」那场。报告仍打印全量，便于人眼看池子。
  const INBOX_MIN_OVERLAP = 0.4;
  if (!opt('no-dream') && !quick) {
    const dr = step('dream', () => findDreamPairs(dir, { limit: Number.MAX_SAFE_INTEGER, near: true }));
    if (dr) {
      for (const line of formatDreamReport({ ...dr, candidates: dr.candidates.slice(0, 20) })) log(line);
      // 门槛只在**入箱**这一步生效，不动报告（报告要能看到被门槛挡掉的池子大小）
      const high = (dr.candidates || []).filter((c) => (c.overlap ?? 0) >= INBOX_MIN_OVERLAP);
      const drInbox = { ...dr, candidates: high };
      const di = step('inbox', () => ingestCandidates(dir, drInbox)) || { pending: 0 };
      if (dr.candidates && dr.candidates.length) {
        log('⑧ 入箱门槛：overlap >= ' + INBOX_MIN_OVERLAP + ' ⇒ ' + high.length + '/' + dr.candidates.length + ' 组进收件箱');
      }
      // 按天索引页（2026-10-18）：每天自动生成/覆盖当天那页
      step('day-split', () => { writeDaySplit(dir, day(), log); return {}; });
      if (di.pending) {
        log('⑧ 联想收件箱：待审 ' + di.pending + ' 条（新增 ' + di.added + '、刷新 ' + di.refreshed
          + (di.dropped ? '、降级 ' + di.dropped : '') + (di.killed ? '、已否决跳过 ' + di.killed : '') + '）'
          + '｜→ `cli dream-inbox list`｜文件 ' + path.join(dir, 'dream-inbox.md'));
      }
    }
  }

  // 分段耗时（2026-10-23 新增：以后不用再手工探针 —— 谁慢一眼看出来）
  log('[分段] ' + marks.map((m) => {
    if (!m.ok) return m.name + ' ⚠️' + (m.err ? '（' + m.err + '）' : '');
    if (m.skipped) return m.name + '·跳过';
    return m.name + ' ' + (m.ms / 1000).toFixed(1) + 's';
  }).join('｜') + '｜合计 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  // ⑨ 旧版记忆库（异步、不等待）。`--no-legacy` 关掉；**再加一道节流**（2026-10-23）：
  //    计划任务 `DSH-Memory-Backup` 单独跑同一个 auto_memory.mjs（实测 **104 秒**），
  //    ⚠️ 它的重复间隔是 **PT6H（每 6 小时）**、不是 30 分钟（2026-10-23 查 Repetition.Interval 实测；
  //    每 30 分钟那个是 `DSH-Memory-Bank-Save` 跑 tick）。19:30 那个 tick 任务**不带** `--no-legacy`
  //    ⇒ 同一份活儿在 6 小时内被白跑第二遍。
  //    ⚠️ 改计划任务参数要管理员权限（2026-10-23 实测 Set-ScheduledTask/schtasks 双双 Access denied），
  //    所以判据放在代码里：读**它自己的产物** `state/last_run.log` 的 mtime（DB 那个任务的输出就是它），
  //    新鲜就说明刚跑过；哪天备份任务停了、日志超过 LEGACY_EVERY_MIN ⇒ tick 自己兜底跑。
  const LEGACY_EVERY_MIN = 360;   // 6 小时 = DSH-Memory-Backup 的周期（PT6H），它刚跑过就不重复
  if (!opt('no-legacy') && !quick) {
    let legacyAgeMin = Infinity;
    try { legacyAgeMin = (Date.now() - fs.statSync('E:/2/_dsh_memory/state/last_run.log').mtimeMs) / 60000; } catch { /* 没跑过 ⇒ 照跑 */ }
    if (legacyAgeMin < LEGACY_EVERY_MIN) {
      log(`[记忆银行] 旧版记忆库：跳过（${Math.round(legacyAgeMin)} 分钟前刚被 DSH-Memory-Backup 刷过）`);
    } else {
      try {
        const legacy = 'E:/2/_dsh_memory/auto_memory.mjs';
        if (fs.existsSync(legacy)) {
          const c = spawn(process.execPath, [legacy], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
          c.on('exit', () => log('[记忆银行] 旧版记忆库已刷新'));
        }
      } catch { /* 旧库刷新失败不拖垮 tick */ }
    }
  }
}
