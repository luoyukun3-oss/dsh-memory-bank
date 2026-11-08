// PostToolUse hook（matcher: write|edit）—— 写入类工具执行后，按「高风险写入」注入自检提醒
// ============================================================================
// ⚠️ 为什么是 PostToolUse 而不是 PreToolUse（2026-09-28 读源码后的结论，别退回）：
//   桥接 `E:\dsh-hooks-bridge\lib\index.js`（link: 到 profiles）里 PreToolUse 分支
//   **只映射 deny / ask** —— `if (merged.decision === 'deny') …` 之后直接 `return next()`，
//   **不消费 merged.additionalContext** ⇒ 在 PreToolUse 里输出提醒会被**静默丢弃**。
//   而 PostToolUse 分支（约 265-291 行）会把 additionalContexts 注入后续上下文 ✓
//   ⇒ 「写之前注入提醒」在当前桥接上做不到；本 hook 落在**写之后**：
//     对**下一次**写操作起事前作用，对「写完要验证」当场起效。
//
// 输入：stdin JSON（Claude Code PostToolUse payload：tool_name / tool_input / tool_response）
// 输出：命中高风险写入 → {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}
//       其余情况**静默退出**（不注入任何东西，避免每次写文件都灌一句废话）
//
// ⚠️ hook 跑在**只读沙箱**里（2026-09-18 实测：连 spawn 都被禁）：
//    本脚本只读 stdin、只写 stdout，**不碰文件系统**，也不 spawn 子进程。
import { readPayload } from './payload.mjs';
import { MEM_ROOT, touchLive } from '../live.mjs';

/** 高风险写入 → 该提醒什么。返回空数组＝不注入（保持安静）。 */
function risksOf(p) {
  const out = [];
  if (!p) return out;
  const norm = p.replace(/\//g, '\\');
  // ① 工作区外 / 系统路径
  if (!/^E:\\2\\/i.test(norm)) out.push('工作区外／系统路径 → 备份了吗？改完读回来验证了吗？');
  // ② 配置与指令文件（改了会影响后续所有会话）
  if (/(^|\\)(AGENTS\.md|settings\.yaml|hooks\.json|cordis[^\\]*\.ya?ml|package\.json)$/i.test(norm)) {
    out.push('配置／指令文件 → 改前备份了吗？改完验证了吗？（hook 改 hooks.json 需重启或热载才生效）');
  }
  // ③ 记忆库的**知识页**（repos/<slug>/pages/*.md）：手改不会自动重建索引 —— 2026-09-23 踩过
  if (/_dsh_memory\\repos\\[^\\]+\\pages\\[^\\]+\.md$/i.test(norm)) {
    out.push('知识页 → 手改要 reindex（tools/reindex-page.mjs <页名>）；改结构要 cli preview 验证注入');
  // ④ 记忆库的**代码 / 数据**（bank|tools 下的 .mjs/.json）：要的是语法与回归检查，reindex 对它没意义
  //    ⚠️ 2026-09-29 收窄：原先这条与 ③ 合并写在一条正则里，于是改 `bank/*.mjs` 也会被提示「要 reindex」（不适用、属噪声）。
  //    ⚠️ 2026-09-29 再修（放宽到子目录）：原先要求 `bank|tools` 的**下一层直接是文件**，
  //    于是 `bank\hooks\*.mjs`（多一层）**不匹配**。这条是当场撞上的 —— 当天我改了两次
  //    `hooks/user-prompt.mjs`，本 hook 一次提醒都没出声（带正对照实测：改 `bank\cli.mjs`
  //    输出 272 字符，改 `bank\hooks\user-prompt.mjs` 输出 0）。⇒ 允许任意层子目录。
  } else if (/_dsh_memory\\(bank|tools)\\(?:[^\\]+\\)*[^\\]+\.(mjs|js|cjs|json)$/i.test(norm)) {
    out.push('记忆银行代码 → 先 `node --check`，再跑 `test.mjs`（全套断言）；新增模块必须登记 `budgets.json`，否则不进行数红线');
  }
  return out;
}

let out = '';
try {
  const payload = readPayload();
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input || {};
  const file = String(input.file_path || input.path || input.notebook_path || '');
  // 短期实时记忆：记下这个会话刚改了哪个文件（写不进去静默跳过；本 hook 原本不碰文件系统）
  touchLive(MEM_ROOT, { sessionId: payload.session_id, event: 'PostToolUse', files: file ? [file] : [] });
  const risks = risksOf(file);
  if (risks.length) {
    const short = file.length > 90 ? file.slice(0, 90) + '…' : file;
    out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `【自检提醒 · 刚用 ${tool} 写入 ${short}】\n`
          + risks.map((r) => `· ${r}`).join('\n')
          + '\n（依据 AGENTS.md 的「输出自检」段：写前备份／写完验证／说"完成了"前核对。若本轮已完成，忽略即可。）',
      },
    });
  }
} catch { /* 判据出错时不注入，绝不因为提醒本身打断主流程 */ }

// 注意：不能 write 后立刻 exit —— 管道/文件目标下会被截断（user-prompt.mjs 同款处理）
if (out) process.stdout.write(out, () => process.exit(0));
else process.exit(0);
