// SessionStart hook：会话开始时自动把「记忆银行摘要」注入上下文（自动召回）
// 输入：stdin JSON（Claude Code hook payload）或 --payload-file <path>
// 输出：{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
//
// ⚠️ 由 DSH 通过 ctx.shell（pwsh-sandbox 执行器）运行：读正常；写若被拒必须报到 stderr，
//    否则会被静默吞掉（桥接会把 stderr 记进 hook/result.stderrSummary）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugOf, ensureRepo, bootstrapText } from '../bank.mjs';
import { readPayload } from './payload.mjs';
import { MEM_ROOT, touchLive, liveText } from '../live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.mjs');
const warn = (msg) => { try { process.stderr.write(`[memory-bank] ${msg}\n`); } catch {} };

let out = '';
try {
  const payload = readPayload(warn);   // 拆分自 2026-09-29：实现在 hooks/payload.mjs；传 warn ⇒ 解析失败照旧报 stderr
  const cwd = path.resolve(payload.cwd || process.env.CLAUDE_PROJECT_DIR || 'E:\\2');
  const slug = slugOf(cwd);
  const dir = ensureRepo(slug, cwd);

  // 写入能力探测（静默通过；被拒时报告）
  try {
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
  } catch (e) {
    warn(`写入被拒（${e.code || e.message}）：钩子在受限沙箱中运行，自动保存退化为计划任务`);
  }

  // 顺手在后台补齐上一次会话的记忆（不阻塞会话启动）
  // ⚠️ 2026-09-18 实测：hook 沙箱**连 spawn 都禁止**（返回 EPERM，子进程根本没起来），
  //    所以这一段实际从未生效；且 `spawn()` 的失败是**异步 error 事件**，外层 try/catch
  //    抓不到 ⇒ 一直是静默失败。补 'error' 监听让事实可见。
  try {
    const child = spawn(process.execPath, [CLI, 'ingest', '--cwd', cwd], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', (e) => warn(`SPAWN-REJECT:${e.code || e.message}`));
    child.unref();
  } catch (e) {
    warn(`后台摄入启动失败：${e.code || e.message}`);
  }

  // 短期实时记忆：登记本会话；并把「别的会话在干什么」拼在开场注入末尾（无则空串）
  touchLive(MEM_ROOT, { sessionId: payload.session_id, cwd, event: 'SessionStart' });
  const live = liveText(MEM_ROOT, { selfId: payload.session_id });
  const ctx = [bootstrapText(dir), live].filter((x) => x && x.trim()).join('\n\n');
  if (ctx && ctx.trim()) {
    out = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
    });
  }
} catch (e) {
  // 钩子永不破坏会话，但错误要可见
  warn(`session-start 失败：${e.message}`);
}

// 注意：不能 write 后立刻 exit —— 管道/文件目标下会被截断
if (out) process.stdout.write(out, () => process.exit(0));
else process.exit(0);
