// PreToolUse hook —— 「动手前拦截」：把已知会静默吃掉参数的写法挡在执行之前
// ============================================================================
// 为什么走 PreToolUse（而不是 PostToolUse 联想）：
//   我犯的那次错是**静默成功** —— cli 回显「已写入 pages/notes.md」，
//   输出里**没有任何异常字样**，所以「看到输出里的触发词才想起」这套机制
//   从原理上救不了它（病在**构造命令的那一刻**，不在看输出的那一刻）。
//   ⇒ 必须在 tools/pre-execute 拦下。
//
// ⚠️ PreToolUse 的输出协议（读 asar 源码得来，别写错）：
//   桥接只消费 `decision`（deny / ask），**不消费 additionalContext** ——
//   所以这里**不能**靠注入提醒，只能**拦住**并把正确写法写进 reason。
//   （同族证据：hooks/post-write.mjs 头注释 2026-09-28 的结论，两处一致）
//
// ⚠️ hook 跑在只读沙箱：只读 stdin、只写 stdout，**不 spawn、不碰文件系统**。
//
// 2026-11-09 按域拆分：判据（纯函数、零 IO）搬到 ./pre-tool-rules.mjs
//   —— 本文件实测 146 / 预算 150（97%）逼近红线，按 budgets.json 的「超限先按域拆」处理。
//   ⚠️ **本文件仍是 DSH 挂载的入口，路径不许变**；判据的导出经由下面那行原样转出。
// ============================================================================
import { readPayload } from './payload.mjs';
import { escapeHatch, risksOf } from './pre-tool-rules.mjs';

export { risksOf } from './pre-tool-rules.mjs';   // 对外导出集合不变（拆分前也就只有它）

// ⚠️ 只在**作为主模块运行**时读 stdin（2026-10-14 修）：
//   原先主逻辑在模块顶层无条件执行，于是 `import` 本文件做单元测试时，
//   readPayload() 会去 readFileSync(0) 等 stdin EOF ⇒ **永久阻塞、无输出**。
//   实测症状：`import('.../pre-tool.mjs')` 的进程静默挂死（status=null、stderr 空）。
//   ⇒ 判据与 hook 常规写法一致：hook 永远以主模块身份被 spawn，加这层判断不影响功能。
const IS_MAIN = (() => {
  try {
    const self = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
    return process.argv[1] && self.toLowerCase().endsWith(process.argv[1].replace(/\//g, '\\').toLowerCase());
  } catch { return false; }
})();

if (IS_MAIN) {
  let out = '';
  try {
    const p = readPayload();
    const tool = String(p.tool_name || '');
    // 只管执行类工具；写/读类工具走各自已有的 hook
    if (/^(pwsh|bash|shell|exec|run_command)$/i.test(tool)) {
      const input = p.tool_input || {};
      const cmd = String(input.command ?? input.cmd ?? input.script ?? '');
      if (cmd && !escapeHatch(cmd)) {
        const risks = risksOf(cmd);
        if (risks.length) {
          const reason = '【PreToolUse 拦下 · 已知会静默吃参数的写法】\n'
            + risks.map((r, i) => `${i + 1}. 问题：${r.what}\n   改法：${r.fix}`).join('\n')
            + '\n（这类错的共同点是**静默成功** —— 命令会照常跑完、输出看着正常，'
            + '所以只能靠动手前拦。若确认本次无害，在命令里加 `# hook-allow` 放行。）';
          out = JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason,
            },
          });
        }
      }
    }
  } catch { /* 判据出错时不拦 —— 拦截是保险，永远不该打断主流程 */ }

  if (out) process.stdout.write(out, () => process.exit(0));
  else process.exit(0);
}
