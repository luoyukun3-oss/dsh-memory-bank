// UserPromptSubmit hook：按当次提问自动召回相关记忆（附加到上下文），并后台补记忆
// 输入：stdin JSON（含 prompt / cwd）或 --payload-file <path>
// 输出：命中时返回 {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}
//
// ⚠️ 本脚本由 DSH 通过 ctx.shell（pwsh-sandbox 执行器）运行，可能处于受限沙箱中：
//    - 读操作正常；
//    - 写操作若被拒，必须把错误写到 stderr（桥接会记进 hook/result.stderrSummary），
//      否则会被静默吞掉、无法排查。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugOf, ensureRepo, recall, readJson } from '../bank.mjs';
import { INJECT_MIN_SCORE } from '../config-keys.mjs';
import { bumpAccess } from '../core.mjs';
import { formatCueNote, loadCueTable, matchCues } from '../cue.mjs';
import { readPayload } from './payload.mjs';
import { MEM_ROOT, touchLive, liveText } from '../live.mjs';
import fs from 'node:fs';
import { readSelfState } from './self-state.mjs';   // 自身状态段（2026-10-26 拆出）
import { ledgerCue } from './ledger-cue.mjs';       // 记账指令检测（2026-10-27）

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.mjs');
// 命中阈值：值一律取自 config-keys.mjs 的 INJECT_MIN_SCORE（标定史与样本对照也在那边）。
// ⚠️ 本文件**不写值、不抄史** —— 2026-09-19 实测过：注释抄数值必然漂移，只有单一真相源挡得住。
const MIN_SCORE = INJECT_MIN_SCORE;
const BG_INTERVAL_MS = 90_000;

// —— 每轮自检提醒（2026-09-29 用户拍板）：全 DSH 里每轮都跑、且能注入上下文的只有本 hook。
//   ⚠️ 别改挂到 Stop（它不消费 additionalContext，会被静默丢弃）；依据与实测见 procedures.md，置空即关闭。
// —— 硬约束（2026-10-31 用户定：「硬约束一定要保证全注入」+「到时候触发压缩」+「到时候精简注入」）：
//   为什么放在**每轮**钩子而不是只靠开场注入 —— 实测依据（2026-10-31 扫 50 个会话）：
//     · 压缩机制是 `compaction/start → prune → summary → end`，8 个会话触发过；
//     · `compaction/prune` 剪掉的**只有 tool/result**（单条 2~12k tokens 的大块工具输出）；
//     · 但 `compaction/summary` 生成的摘要里，**6 次全部不含「全局偏好」「硬要求」「简体中文」**
//       ⇒ 开场注入的原文一旦被摘要取代，硬约束就从上下文里消失了。
//   ⇒ 每轮重发。**必须短**：全文在 `_global/pages/preferences.md` 的「硬要求」，
//     这里只发口令 —— 一行、不带举例、不带理由（理由我刚删过一次，别再写回来）。
// 2026-10-31 追加第二句（用户问「深度思考要怎么做加硬约束吗」）：**该加，理由与验证那条同源** ——
//   「要思维链就真用思维链」原先只写在开场注入的「语气底线」里，压缩后照样消失；
//   而**长会话恰好是推理最容易退化成一句结论的场景**（上下文越长、越倾向省字）。
//   ⇒ 两句合一，仍然一行：前半句管「推理够不够深」，后半句管「结论有没有证据」。
//   ⚠️ 别写成"要好好思考"这种废话 —— 它的可执行点是"复杂问题不许一步跳结论"。
const HARD = '（硬约束）① 推理要落地：复杂问题先想清楚再答，别省成一句结论；'
  + '② 结论先证明再说话，证据必须是这一轮跑的；验不了写「推测」。';

const SELFCHECK = '（每轮自检 · 三时刻）'
  + '① 写文件／改配置前：备份了吗、锚点对吗、写完验证了吗？'
  + '② 说事实性结论前（数字／时间／状态）：是刚查过的，还是"我记得"？'
  + '③ 说"完成了"之前：对方的回话看到了吗、真的做完了吗？'
  + '——自检要留可查痕迹（一句"依据＝刚跑的 X"／一次 read／一个 diff）；心里默念不算。';

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
  let cueNote = '';   // 触发式联想的注入段（见下）
  if (prompt.trim().length >= 4) {
    const { hits, text } = recall(dir, prompt, { k: 4, budget: 1100, touch: true });
    const strong = hits.filter((h) => h.score >= MIN_SCORE);
    // —— HITS 通道：hook 写不了文件，但 stderr 会被原样记进会话日志的 `hook/result.stderrSummary`
    //    ⇒ 唯一持久通道，供 ingest 累计「共现」（自动联想的数据基础）。格式固定 `HITS:` 前缀，只记标识。
    if (hits.length) warn(`HITS:${hits.map((h) => h.id || h.page).join(',')}`);
    if (strong.length && text) {
      // 命中召回 → 先记下，最后与自检提醒合并（别在这里直接赋 out，否则自检会被挤掉）
      memNote = '（记忆银行命中，供参考；与当前任务无关时忽略）\n' + text;
    }
    // —— 触发式联想（2026-10-13）：**刻意不看主命中的分数** —— 命中触发词就带出来。
    //    这是用户的要求（"看到乱码就想到编码格式"）：条件反射不该等别的事先被想起来。
    //    ⚠️ 它绕过了 MIN_SCORE 这道噪声防线，代价靠**词表**控制（df 门 + 人工 cue 标注），
    //    不是靠分数 —— 词表跑偏了要改词表，别在这里加分数门槛，那会让它退回 assoc 那种"搭车"形态。
    //    2026-11-07 加「教训命中计数」：cue 命中的条目 id 也 bump 进 access.json ——
    //    此前只有主召回计数，cue 这条「教训被看见」的主通道完全没记录，
    //    trial 质控（长期 0 命中 → 哑弹候选）会因此误判。bumpAccess 自带容错，失败不影响注入。
    try {
      const cueHits = matchCues(loadCueTable(dir, null), prompt, 'prompt');
      cueNote = formatCueNote(cueHits);
      if (cueHits.length) bumpAccess(dir, cueHits.map((h) => h.id));
    } catch { /* 联想失败不拖累召回 */ }
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
