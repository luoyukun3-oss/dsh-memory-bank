// ============================================================================
// test-tick-maintain.mjs —— tick 的「周期维护」段（2026-11-09）
//
// 守的是什么：这一段会在 tick 里**自动删备份文件**。所以三件事必须有断言：
//   ① 节流真的生效（第一次跑、第二次跳过、过了窗口再跑）
//   ② 只删自动产物，`_bak/` 人工快照一个都不许动
//   ③ 失败时不写 stamp（否则一次失败会被记成"刚跑过"，要等下一整轮）
//
// ⚠️ 全部在**临时目录**造数据 + **注入假的 runTool**：不碰真实备份、不真跑 graph-render。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GRAPH_EVERY_MIN, ROTATE_EVERY_MIN, runLegacyRefresh, runMaintain } from './commands/tick-maintain.mjs';

let pass = 0;
const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) { pass += 1; console.log('  [OK] ' + msg + (extra ? '（' + extra + '）' : '')); return; }
  fails.push(msg + (extra ? '（' + extra + '）' : ''));
  console.log('  [FAIL] ' + msg + (extra ? '（' + extra + '）' : ''));
};

/** 模拟 cli.mjs 的 opt（`--k v` / `--flag`） */
const mkOpt = (argv = []) => (name, fb) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return fb;
  const next = argv[i + 1];
  return next !== void 0 && !String(next).startsWith('--') ? next : true;
};

const NOW = new Date('2026-11-09T16:00:00+08:00').getTime();
const HOUR = 3600 * 1000;

/** 造一个临时 _dsh_memory + repo：15 份自动产物（同一 base、今天不同小时）+ 1 份人工快照 */
function makeMem() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-maint-'));
  const mem = path.join(root, 'mem');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(mem, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(mem, '_bak'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'state'), { recursive: true });
  for (let i = 0; i < 15; i += 1) {
    const f = path.join(mem, 'pages', 'lessons.md.bak-2026110' + i);
    fs.writeFileSync(f, 'x'.repeat(100));
    const t = (NOW - (15 - i) * HOUR) / 1000;   // i 越大越新
    fs.utimesSync(f, t, t);
  }
  fs.writeFileSync(path.join(mem, '_bak', 'manual.bak-keep'), 'y'.repeat(50));
  return { root, mem, repo };
}

const countAuto = (mem) => fs.readdirSync(path.join(mem, 'pages')).filter((f) => f.includes('.bak-')).length;

console.log('== 1. 第一次跑：真的执行（轮转 + 图谱），且只删自动产物 ==');
const m1 = makeMem();
ok(countAuto(m1.mem) === 15, '起手 15 份自动产物', '实得 ' + countAuto(m1.mem));
const tools1 = [];
const runTool = (tool, repo) => { tools1.push({ tool: path.basename(tool), repo }); return { status: 0, stdout: 'ok' }; };
const logs1 = [];
const r1 = runMaintain({ dir: m1.repo, opt: mkOpt(), log: (s) => logs1.push(s), memRoot: m1.mem, runTool, now: NOW });
ok(r1.skipped === false, '第一次**不算跳过**（节流窗口是空的）', 'skipped=' + r1.skipped);
ok(r1.rotate.auto === 15, '扫到 15 份自动产物', 'auto=' + r1.rotate.auto);
ok(r1.rotate.manual === 1, '扫到 1 份人工快照（单独归类）', 'manual=' + r1.rotate.manual);
ok(r1.rotate.planned === 5 && r1.rotate.deleted === 5, '每文件保留最近 10 份 ⇒ 删 5 份', 'planned=' + r1.rotate.planned + ' deleted=' + r1.rotate.deleted);
ok(countAuto(m1.mem) === 10, '磁盘上真的只剩 10 份', '实得 ' + countAuto(m1.mem));
ok(fs.existsSync(path.join(m1.mem, '_bak', 'manual.bak-keep')), '★ `_bak/` 人工快照一个没少');
ok(tools1.length === 2 && tools1.every((t) => t.repo === m1.repo), '两个渲染工具都被调用，且 repo 参数传的是当前库', tools1.map((t) => t.tool).join('+'));
ok(r1.graph.ok === true && r1.graph.done.length === 2, '图谱结果 ok', JSON.stringify(r1.graph.done));
ok(fs.existsSync(path.join(m1.repo, 'state', 'rotate-stamp.json')), 'rotate-stamp.json 已写');
ok(fs.existsSync(path.join(m1.repo, 'state', 'graph-stamp.json')), 'graph-stamp.json 已写');
ok(/轮转：删 5 个/.test(r1.note) && /图谱：已刷新/.test(r1.note), '汇总 note 说清了做了什么', r1.note);

console.log('== 2. 第二次跑（窗口内）：两件都跳过，且不再动手 ==');
const before2 = countAuto(m1.mem);
const tools2 = [];
const r2 = runMaintain({ dir: m1.repo, opt: mkOpt(), log: () => {}, memRoot: m1.mem, runTool: (t, r) => { tools2.push(t); return { status: 0 }; }, now: NOW + 1 * HOUR });
ok(r2.skipped === true, '★ 20 小时窗口内 ⇒ skipped=true（tick 的 step 会标「·跳过」）', 'skipped=' + r2.skipped);
ok(r2.rotate === null && r2.graph === null, '两件都没执行（返回 null）');
ok(tools2.length === 0, '渲染工具一次都没被调用');
ok(countAuto(m1.mem) === before2, '文件数没变（' + before2 + '）');
ok(/轮转：跳过/.test(r2.note) && /图谱：跳过/.test(r2.note), 'note 里带「跳过」与已过分钟数', r2.note);

console.log('== 3. 过了节流窗口：两件都会再跑 ==');
const r3 = runMaintain({ dir: m1.repo, opt: mkOpt(), log: () => {}, memRoot: m1.mem, runTool: () => ({ status: 0 }), now: NOW + (ROTATE_EVERY_MIN + 1) * 60000 });
ok(r3.skipped === false, '超过 ' + ROTATE_EVERY_MIN + ' 分钟 ⇒ 重新执行', 'skipped=' + r3.skipped);
ok(r3.rotate && r3.rotate.planned === 0, '此时只剩 10 份，无需再删', 'planned=' + (r3.rotate && r3.rotate.planned));

console.log('== 4. 单件跳过时**不能**标 skipped（否则真跑了会被误标成·跳过）==');
const m4 = makeMem();
// 先把 graph 的 stamp 写成"刚刚刷过"，让 rotate 该跑、graph 该跳
fs.writeFileSync(path.join(m4.repo, 'state', 'graph-stamp.json'), JSON.stringify({ at: NOW }));
const r4 = runMaintain({ dir: m4.repo, opt: mkOpt(), log: () => {}, memRoot: m4.mem, runTool: () => ({ status: 0 }), now: NOW });
ok(r4.rotate && r4.rotate.deleted > 0, 'rotate 照常执行', 'deleted=' + (r4.rotate && r4.rotate.deleted));
ok(r4.skipped === false, '★ 只跑了一件 ⇒ skipped=false（不是 true）', 'skipped=' + r4.skipped);
ok(/图谱：跳过/.test(r4.note), 'graph 如实报跳过', r4.note);

console.log('== 5. 开关：--no-rotate / --no-graph / --rotate-dry ==');
const m5 = makeMem();
const r5a = runMaintain({ dir: m5.repo, opt: mkOpt(['--no-rotate', '--no-graph']), log: () => {}, memRoot: m5.mem, runTool: () => ({ status: 0 }), now: NOW });
ok(r5a.rotate === null && r5a.graph === null && r5a.skipped === true, '两个开关都关 ⇒ 都不跑', r5a.note);
ok(/轮转：关闭/.test(r5a.note) && /图谱：关闭/.test(r5a.note), 'note 写明是"关闭"而不是"跳过"');
ok(countAuto(m5.mem) === 15, '关掉后一个文件都没删', '实得 ' + countAuto(m5.mem));
const r5b = runMaintain({ dir: m5.repo, opt: mkOpt(['--rotate-dry', '--no-graph']), log: () => {}, memRoot: m5.mem, runTool: () => ({ status: 0 }), now: NOW });
ok(r5b.rotate && r5b.rotate.deleted === 0 && r5b.rotate.apply === false, '--rotate-dry ⇒ 记账但不真删', 'deleted=' + r5b.rotate.deleted);
ok(countAuto(m5.mem) === 15, '★ dry-run 后文件数不变', '实得 ' + countAuto(m5.mem));

console.log('== 6. 图谱失败 ⇒ 不写 graph-stamp（下次照常重试）==');
const m6 = makeMem();
const r6 = runMaintain({ dir: m6.repo, opt: mkOpt(['--no-rotate']), log: () => {}, memRoot: m6.mem, runTool: () => ({ status: 1 }), now: NOW });
ok(r6.graph && r6.graph.ok === false, '失败被如实记录', JSON.stringify(r6.graph.bad));
ok(!fs.existsSync(path.join(m6.repo, 'state', 'graph-stamp.json')), '★ 失败不写 stamp ⇒ 下次仍会重试');
ok(r6.skipped === false, '跑了但失败 ⇒ 不算 skipped');
const r6b = runMaintain({ dir: m6.repo, opt: mkOpt(['--no-rotate']), log: () => {}, memRoot: m6.mem, runTool: () => ({ status: 0 }), now: NOW + 60000 });
ok(r6b.graph && r6b.graph.ok === true, '下一次（工具恢复）立刻重试成功', JSON.stringify(r6b.graph.done));

console.log('== 7. runLegacyRefresh：log 新鲜就跳过、过期才兜底 ==');
const m7 = makeMem();
const freshLog = path.join(m7.root, 'last_run.log');
fs.writeFileSync(freshLog, 'x');
const l1 = runLegacyRefresh({ opt: mkOpt(), log: () => {}, logFile: freshLog, legacyScript: path.join(m7.root, 'nope.mjs'), now: NOW });
ok(l1.skipped === true, '日志刚写过 ⇒ 跳过（不重复跑 104 秒的活）');
const oldLog = path.join(m7.root, 'old_run.log');
fs.writeFileSync(oldLog, 'x');
const oldSec = (NOW - 8 * HOUR) / 1000;
fs.utimesSync(oldLog, oldSec, oldSec);
const l2 = runLegacyRefresh({ opt: mkOpt(), log: () => {}, logFile: oldLog, legacyScript: path.join(m7.root, 'nope.mjs'), now: NOW });
ok(l2.skipped === false && l2.spawned === false, '日志过期但脚本不存在 ⇒ 不抛、如实报没跑', JSON.stringify(l2));
const l3 = runLegacyRefresh({ opt: mkOpt(['--no-legacy']), log: () => {}, logFile: oldLog, legacyScript: path.join(m7.root, 'nope.mjs'), now: NOW });
ok(l3.skipped === true, '--no-legacy ⇒ 直接跳过');

console.log('== 8. 节流常量本身 ==');
ok(ROTATE_EVERY_MIN === 1200 && GRAPH_EVERY_MIN === 1200, '两条都是 20 小时（1200 分钟）', ROTATE_EVERY_MIN + '/' + GRAPH_EVERY_MIN);
ok(ROTATE_EVERY_MIN > 720, '> 12 小时 ⇒ 一天最多一次（不会跟着 30 分钟的 tick 反复跑）');

console.log('');
if (fails.length) {
  console.log('结果：' + pass + ' 通过 / ' + fails.length + ' 失败');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('结果：' + pass + ' 通过 / 0 失败');
