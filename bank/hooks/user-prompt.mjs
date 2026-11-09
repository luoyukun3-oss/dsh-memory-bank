// UserPromptSubmit hook：按当次提问自动召回相关记忆（附加到上下文），并后台补记忆
// 输入：stdin JSON（含 prompt / cwd）或 --payload-file <path>
// 输出：命中时返回 {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}
//
// ⚠️ 本脚本由 DSH 通过 ctx.shell（pwsh-sandbox 执行器）运行，可能处于受限沙箱中：
//    - 读操作正常；
//    - 写操作若被拒，必须把错误写到 stderr（桥接会记进 hook/result.stderrSummary），
//      否则会被静默吞掉、无法排查。
//
// 2026-11-09 按域拆分（本文件实测 168 / 预算 170 = 99%，按「超限先按域拆」处理）：
//   ① 两段固定口令（HARD / SELFCHECK）→ ./prompt-hard.mjs
//   ② 召回与联想（扩展/降级/HITS/低分路标/触发式联想）→ ./prompt-recall.mjs
//   ⚠️ **本文件仍是 DSH 挂载的入口，路径不许变**；真正决定「注入什么、按什么顺序」的仍是这里。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugOf, ensureRepo, readJson } from '../bank.mjs';
import { INJECT_MIN_SCORE } from '../config-keys.mjs';
import { readPayload } from './payload.mjs';
import { MEM_ROOT, touchLive, liveText } from '../live.mjs';
import { readSelfState } from './self-state.mjs';   // 自身状态段（2026-10-26 拆出）
import { ledgerCue } from './ledger-cue.mjs';       // 记账指令检测（2026-10-27）
import { HARD, SELFCHECK } from './prompt-hard.mjs';                    // 每轮固定口令（2026-11-09 拆出）
import { cueNoteOf, nearNoteOf, runRecall } from './prompt-recall.mjs'; // 召回与联想（2026-11-09 拆出）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.mjs');
// 命中阈值：值一律取自 config-keys.mjs 的 INJECT_MIN_SCORE（标定史与样本对照也在那边）。
// ⚠️ 本文件**不写值、不抄史** —— 2026-09-19 实测过：注释抄数值必然漂移，只有单一真相源挡得住。
// ⚠️ 2026-11-09：`h.score >= MIN_SCORE` 这行**必须留在本文件**（别挪进 prompt-recall.mjs）——
//    test-mood.mjs 有一条源码守护断言靠读它来保证「注入触发只认 score」。
const MIN_SCORE = INJECT_MIN_SCORE;
const BG_INTERVAL_MS = 90_000;

const warn = (msg) => { try { process.stderr.write(`[memory-bank] ${msg}\n`); } catch {} };
// 自身状态段已搬到 hooks/self-state.mjs（2026-10-26 按域拆：本文件 186/170 超限）

let out = '';
try {
  const payload = readPayload(warn);   // 拆分自 2026-09-29：实现在 hooks/payload.mjs；传 warn ⇒ 解析失败照旧报 stderr
  const cwd = path.resolve(payload.cwd || process.env.CLAUDE_PROJECT_DIR || 'E:\\2');
  const prompt = String(payload.prompt || payload.user_prompt || '');
  let memNote = ''; // 召回命中时的文本，最后与 SELFCHECK 合并注入（见 try 末尾的统一出口）
  const slug = slugOf(cwd);
  const dir = ensureRepo(slug, cwd);

  // —— 写入能力：hook 跑在 read-only 沙箱（实测 41/41 条 EPERM，连 cwd 都写不了，且不受会话权限影响）。
  //   ⇒ 限流不能用 `.bg.json`（写不进 ⇒ 恒真 ⇒ 每次提问都白跑 ingest）；改**读** `bank.json.lastIngestAt`。

  // —— 自动保存：后台增量摄入（限流）。⚠️ spawn 也常被沙箱拒（EPERM）且是**异步 error**、try/catch 抓不到，
  //   所以必须挂 'error' 监听让失败可见（前缀固定，别干扰 HITS 正则）。
  try {
    const lastIngest = Date.parse(readJson(path.join(dir, 'bank.json'), {}).lastIngestAt || 0) || 0;
    if (Date.now() - lastIngest > BG_INTERVAL_MS) {
      const child = spawn(process.execPath, [CLI, 'ingest', '--cwd', cwd], {
        detached: true, stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      child.on('error', (e) => warn(`SPAWN-REJECT:${e.code || e.message}`));
      child.unref();
    }
  } catch (e) {
    warn(`自动保存失败：${e.code || e.message}`);
  }

  // —— 自动召回：按提问检索记忆银行
  let cueNote = '';   // 触发式联想的注入段（见 prompt-recall.mjs 的 cueNoteOf）
  if (prompt.trim().length >= 4) {
    const { hits, text } = runRecall({ dir, prompt, sessionId: payload.session_id, warn });
    const strong = hits.filter((h) => h.score >= MIN_SCORE);
    // 命中召回 → 先记下，最后与自检提醒合并（别在这里直接赋 out，否则自检会被挤掉）
    if (strong.length && text) memNote = '（记忆银行命中，供参考；与当前任务无关时忽略）\n' + text;
    else memNote = nearNoteOf(hits);   // 有候选但都不够确信 ⇒ 给一行路标（无则空串）
    cueNote = cueNoteOf(dir, prompt);  // 触发式联想：命中触发词就带出来，不看主命中分数
  }

  // 短期实时记忆：更新本会话状态，并取「别的会话在干什么」段（没有别的会话就是空串）
  touchLive(MEM_ROOT, { sessionId: payload.session_id, event: 'UserPromptSubmit', userMsg: payload.prompt });
  const live = liveText(MEM_ROOT, { selfId: payload.session_id });

  // —— 统一出口：自检**每轮都注入**（不受上面 `length >= 4` 召回门槛限制，短指令也带上）
  const stateNote = readSelfState(payload);
  // 记账指令（2026-10-27）：用户说「以后出错直接塞进收件箱」—— 这层是**机械兜底**，
  // 命中「塞进教训收件箱」这类说法就往最前面插一句提醒，不依赖我那一刻想得起来。
  const ledgerNote = ledgerCue(prompt);
  // 硬约束排最前（2026-10-31）：它在压缩后必须每轮重新出现，别被召回/联想段挤到后面。
  const parts = [HARD, ledgerNote, memNote, cueNote, live, stateNote, SELFCHECK].filter(Boolean);
  if (parts.length > 0) {
    out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: parts.join('\n\n'),
      },
    });
  }
} catch (e) {
  warn(`user-prompt 失败：${e.message}`);
}

// 注意：不能 write 后立刻 exit —— 管道/文件目标下会被截断
if (out) process.stdout.write(out, () => process.exit(0));
else process.exit(0);
