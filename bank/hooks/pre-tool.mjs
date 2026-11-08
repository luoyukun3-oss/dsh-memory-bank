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
// ============================================================================
import { readPayload } from './payload.mjs';

/** 安全阀：命中就放行，免得判据写错时把整轮工作锁死。 */
function escapeHatch(cmd) {
  return /#\s*hook-allow|--hook-allow/.test(cmd);
}

/** 剥掉单/双引号字符串的**内容**（保留引号本身），用于判断「变量是不是裸传」。
 *  裸传 = 变量出现在引号外 ⇒ PowerShell 会把多行值按空白切开、只留第一段。 */
function stripQuoted(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      out += "'"; i += 1;
      while (i < line.length && line[i] !== "'") { out += ' '; i += 1; }
      if (i < line.length) { out += "'"; i += 1; }
    } else if (c === '"') {
      out += '"'; i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '`') { out += '  '; i += 2; } else { out += ' '; i += 1; }
      }
      if (i < line.length) { out += '"'; i += 1; }
    } else { out += c; i += 1; }
  }
  return out;
}

/** 外部程序名（这些命令的参数会被 shell/argv 拆分，是受害方）。 */
const EXTERNAL = /\b(node|node\.exe|python|python3|py|docker|git|npm|pnpm|yarn|pip|gh|curl)\b/i;

/**
 * 找出这条命令里的风险。返回 [{ what, fix }]，空数组＝放行。
 * 判据一律取「宁可漏报、不可误报」：误报会打断正常工作，漏报只是回到现状。
 */
export function risksOf(cmd) {
  const out = [];
  if (typeof cmd !== 'string' || cmd.length === 0) return out;
  const lines = cmd.split(/\r?\n/);

  // ── 风险 ①：`cli.mjs remember` 不走 --text-file（零误报，直击我实际犯的那个错）
  //    实测：`$c = Get-Content x.txt -Raw; node cli.mjs remember $c --page p.md`
  //    ⇒ 变量在换行处截断，正文只剩第一行，`--page` 整个消失 ⇒ 落回默认页 notes.md。
  //    ⚠️ 同风险②：一律在 stripQuoted 后的文本上判 —— 免得「引号内提到 --text-file」被判成"带了参数"。
  const flat = lines.map(stripQuoted).join('\n');
  if (/\bcli\.mjs\b/.test(flat) && /\bremember\b/.test(flat) && !/--text-file\b/.test(flat)) {
    out.push({
      what: 'remember 没走 --text-file（正文经 shell 传参会被换行/反引号截断，--page 也会一起消失）',
      fix: '先用 write 工具把正文落成 .txt，再跑：cli.mjs remember --text-file <路径> --page <页名>',
    });
  }

  // ── 风险 ②：`-Raw` 读进变量，再把该变量**裸传**给外部程序
  //    （变量值 hook 看不到，但「多行来源 + 裸传」这个组合本身就是判据）
  // ⚠️ 2026-10-14 修误报（hook 上线后**第一次真实拦截就是拦了我自己**，且是误报）：
  //   实例 = `$cmd = '$c = Get-Content x -Raw' + "`n" + 'node a.mjs $c'`（在拼 payload 字符串）。
  //   三处都判错了，全部同源 —— **把引号里的「数据」当成了「代码」**：
  //     ① 原 `rawVars` 用**原始行**匹配 ⇒ 把单引号里的 `Get-Content … -Raw` 当成了真读文件；
  //     ② 原 `EXTERNAL` 也测**原始行** ⇒ 把单引号里的 `node a.mjs` 当成了真调用；
  //     ③ 再把 `$cmd`（其实只是被赋值）判成"裸传"。
  //   ⇒ 三条统一改法：**一切判据都在 `stripQuoted()` 之后的文本上做**（引号内容已被抹成空格），
  //     并**跳过赋值行**（`$x = …` 是定义，不是传参）。
  const rawVars = new Set();
  for (const line of lines) {
    const m = stripQuoted(line).match(/\$(\w+)\s*=\s*.*\b(Get-Content|gc|cat|type)\b.*-Raw/i);
    if (m) rawVars.add(m[1]);
  }
  if (rawVars.size > 0) {
    for (const line of lines) {
      const bare = stripQuoted(line);            // 只看引号外的部分
      if (/^\s*\$\w+\s*=/.test(bare)) continue;  // 赋值行：定义，不是传参
      if (!EXTERNAL.test(bare)) continue;
      for (const v of rawVars) {
        if (new RegExp(`\\$${v}\\b`).test(bare)) {
          out.push({
            what: `变量 $${v} 来自 -Raw 读取（可能多行），却裸传给了外部命令 ⇒ 换行处会被截断，后续参数一起丢失`,
            fix: `改用文件传参（--text-file 之类）；确需传值就加双引号并确认它是单行`,
          });
          break;
        }
      }
    }
  }

  return out;
}

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
