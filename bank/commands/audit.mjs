// ============================================================================
// Memory Bank · 体检族命令（2026-11-09 从 cli.mjs 按域拆出）：sweep / lines / dead / lessons-audit
//
// 为什么拆：cli.mjs 实测 508/510 行（100%，下一条改动就爆）。按预算表规矩「超限先按域拆、别压行宽」。
// 为什么先拆这四个：它们都是**只读 + 渲染**型（sweep 的 --apply 只归档已完成待办），
//   不写业务数据 ⇒ 回归面最小、最容易验证；先例见 commands/{mood,dream-inbox,rotate,tick}.mjs。
//
// ⚠️ 对外零变化：cli.mjs 的四个 case 合并成一条调度（`runAuditCli(cmd, {...})`），
//    命令名、参数、输出格式全都不动。
// ⚠️ 路径层级别踩：本文件在 bank/commands/，比原来 bank/cli.mjs 深一层 ——
//    `lines` 段要算 `_dsh_memory` 根时 dirname 必须剥三层（commands→bank→_dsh_memory）。
// ============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweepRepo, checkLineBudgets } from '../bank.mjs';
import { auditDegenerate, formatDegenerateReport } from '../degenerate-audit.mjs';
import { auditPatchStatus, formatPatchStatusReport } from '../patch-status.mjs';
import { auditPerf, formatPerfReport } from '../perf-audit.mjs';
import { auditDeadExports, formatDeadReport } from '../dead-audit.mjs';
import { auditLessons, formatDormantReport } from '../lessons-audit.mjs';

/**
 * 体检族四个命令的统一入口 —— cli.mjs 里只留一条调度。
 * @param {string} cmd 命令行第一个词（sweep / lines / dead / lessons-audit）
 * @param {{dir:string, cwd:string, log:Function, opt:Function, argv:string[]}} ctx
 *   dir  仓库目录（ensureRepo 之后）｜cwd  工作目录｜log  打印函数
 *   opt  `--flag` 取值函数｜argv 原始参数（极少数命令要看裸 flag）
 */
export function runAuditCli(cmd, { dir, cwd, log, opt }) {
  switch (cmd) {
  // sweep：定期体检 —— 注入用量 / 各页体积 / 退役候选 / 卡住的队列。
  // 零风险项（已完成待办归档）随 --apply 自动做；有取舍的**只报告**。
  case 'sweep': {
    const r = sweepRepo(dir, { apply: !!opt('apply') });
    log('【记忆银行 · 体检】');
    log(`注入 ${r.injectChars} / ${r.budget} 字（余量 ${r.headroom}）${r.headroom < 300 ? ' ⚠️ 余量偏低' : ' ✅'}`);
    log('');
    log('| 页 | 字数 | 条目 | i≤2 |');
    log('|---|---|---|---|');
    for (const p of r.pages.slice(0, 8)) log(`| ${p.page} | ${p.chars} | ${p.items} | ${p.low || ''} |`);
    log('');
    log(`① 零风险项：${r.tidy ? `已归档已完成待办 ${r.tidy.moved ?? 0} 条` : '未执行（加 --apply 才做）'}`);
    log(`② 待整理队列：inbox ${r.inbox.items} 条${r.inbox.needsWork ? ' ⚠️ 需要出队（整理完就删，别留着 —— 会冒充知识参与召回）' : ' ✅'}`);
    log(`③ 退役候选（i ≤ 2，人工判定过「主人不会再问」）：${r.lowValue.length} 条`);
    for (const x of r.lowValue) log(`   - ${x.page}:${x.line}  ${x.title}（i=${x.i}）`);
    if (r.lowValue.length) {
      log('');
      log('   → 移档（不进检索池也不进注入，等于删；但带 _bak 快照、随时可搬回）：');
      log('     node E:\\2\\_dsh_memory\\bank\\cli.mjs prune --page <页> --match "<正则>" --apply');
    }
    // ④ 段原先被嵌在上面的 if (r.lowValue.length) 内 ⇒ ③ 退役候选为 0 时，
    //    重复条目检测整段不打印（2026-10-10 踩到：当天正好 0 条退役候选，
    //    于是一对 Jaccard 极高的重复条目被藏住、差点漏看）。
    //    ④ 是独立指标（重复 = 内容虚增 + 分数摊薄），与「有没有退役候选」无关 ⇒ 移出块外。
    log('');
    log(`④ 重复条目（Jaccard ≥ 0.8；重复 = 内容虚增 + 分数摊薄）：${r.dupes.length} 对`);
    for (const d of r.dupes) log(`   - ${d.sim}  ${d.a} ←→ ${d.b}  「${d.titleA}」/「${d.titleB}」`);
    if (r.headroomWarn) log(`   ⚠️ 注入余量 ${r.headroom} 低于 800 —— 该瘦身了（否则新增内容会静默顶掉排最后的部分）`);
    // ⑤ 退化消息（2026-09-18 新增）：只有思考、无正文也无工具调用的空消息。
    //    判据、成因、实测证据与打印格式都在 bank/degenerate-audit.mjs（打印外移是因为内联会把本文件顶到 95% 预算）。
    for (const line of formatDegenerateReport(auditDegenerate(cwd))) log(line);
    // ⑥ 外挂补丁自检（2026-09-18 新增）：补丁写在**应用安装目录**里 ⇒ 升级即被覆盖、
    //    不重启不生效，而两种情况**都不报错** ⇒ 必须定期复查，别等下次退化时才发现补丁早没了。
    for (const line of formatPatchStatusReport(auditPatchStatus())) log(line);
    // ⑦ 性能打点 + 内存判据（2026-09-21）：每次 cli 调用退出时自动记一笔，
    //    打印留在 bank/perf-audit.mjs（原因同 ⑤：本文件逼近行数预算）。
    for (const line of formatPerfReport(auditPerf())) log(line);
    break;
  }

  // lines：行数预算体检（架构红线，2026-09-18 借自 dsh-pet）
  // 它的经验：给大文件设**行数预算**、超过即失败，并明确规定
  // 「预算只随实测校准，**不靠压缩行宽/合并语句硬塞**」。这里给人看；test.mjs 里是自动守护。
  case 'lines': {
      const memRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));   // commands/ → bank/ → _dsh_memory/
    const r = checkLineBudgets(memRoot);
    log('【行数预算】可读性护栏，不是 bug 红线 —— 超限才按域拆，别压行宽硬塞；小文件满格不算问题');
    for (const row of r.rows) {
      if (row.missing) { log(`  ?      ${row.file}  （文件不存在）`); continue; }
      // 2026-11-09 主人定：行数预算的意义是**可读性**，不是「到了就出 bug」的物理红线。
      //   所以 ⚠️ 只在「文件本身已经不小（≥200 行）且逼近上限」时才提示 ——
      //   39/40 行、26/30 行这种小文件满格完全无害，再报警只会把人逼去无意义地拆。
      const flag = row.over ? '❌超限' : (row.pct >= 95 && row.lines >= 200) ? '⚠️逼近' : '✅    ';
      log(`  ${flag} ${String(row.lines).padStart(5)} / ${String(row.budget).padStart(5)}  ${String(row.pct).padStart(3)}%  ${row.file}`);
    }
    log('');
    if (r.over.length) {
      log(`❌ ${r.over.length} 个文件超限：${r.over.map((x) => x.file).join('、')}`);
      log('   → 按域拆分后再提交；不要为了塞进去而压缩行宽/合并语句。');
    } else {
      log('✅ 全部在预算内。');
    }
    break;
  }

  // dead：死机制盘点（借 dsh-pet「死机制清理要逐项 grep 零消费证据」）—— 只列证据、不自动删，
  // 因为「真死」的最后一步是判断（可能是留给外部的 API、或计划中的用法）。判据必须两轮，见模块头。
  case 'dead': {
    for (const line of formatDeadReport(auditDeadExports()).split('\n')) log(line);
    break;
  }

  // lessons-audit：教训哑弹审计（2026-11-07 trial 质控）。写成 30 天零命中 ⇒ 哑弹候选，
  // 只报告不删 —— 判死要人判断（同 cli dead 的规矩）。数据源 access.json（召回 + cue 命中都计数）。
  case 'lessons-audit': {
    const r = auditLessons(dir, { days: Number(opt('days', 30)) || 30 });
    for (const line of formatDormantReport(r, { days: Number(opt('days', 30)) || 30 })) log(line);
    break;
  }
  }
}
