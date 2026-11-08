// PostToolUse hook（matcher: 读类工具）—— 「触发式联想」的**眼睛**（2026-10-13 新增）
// ============================================================================
// 它补的是 UserPromptSubmit 看不到的那半边：提问只有几十字，而我**看到的**（工具输出）
// 才是信息量的主体。用户 2026-10-12 的原话正是这个场景：「你经常被编码格式不对看到一堆乱码，
// 那你看到乱码或者看到编码格式就想到」—— 条件是**眼睛看到的**，不是别人说的。
//
// ⚠️ 三个设计约束（都是实测/源码得来的，别改回去）：
//   ① **只认 `cue:` 档**（mode='output'）：工具输出动辄几 KB，泛词的误触发概率比提问高两个数量级。
//      代价是库里没有 cue 标注时本 hook **哑火** —— 这是有意的空转，不是坏了。
//   ② **不写任何文件、不起子进程**：hook 跑在只读沙箱（2026-09-18 实测连 spawn 都 EPERM）。
//      本脚本只读 stdin/cue.json、只写 stdout。
//   ③ **输出必须静默退出**：这个 hook 每轮跑 N 次（N＝本轮工具调用数），
//      没命中就一分上下文都不占 —— 宁可漏也不能每轮灌一句废话（同 post-write 的做法）。
// ============================================================================
import path from 'node:path';
import { readJson, repoDir, slugOf } from '../core.mjs';
import { formatCueNote, loadCueTable, matchCues } from '../cue.mjs';
import { readPayload } from './payload.mjs';

/** 扫描上限：超长输出（几 MB 的日志）没必要全扫，前 4 万字足够覆盖"我实际会读的部分"。 */
const SCAN_MAX = 40000;

/** 从 payload 里取出「我这次看到了什么文本」。形态随工具而异，取不到就返回空串。 */
function toolText(p) {
  const r = p?.tool_response;
  if (typeof r === 'string') return r.slice(0, SCAN_MAX);
  if (r && typeof r === 'object') {
    const parts = [];
    if (typeof r.stdout === 'string') parts.push(r.stdout);
    if (typeof r.stderr === 'string') parts.push(r.stderr);
    if (Array.isArray(r.content)) {
      for (const c of r.content) if (typeof c?.text === 'string') parts.push(c.text);
    }
    if (typeof r.text === 'string') parts.push(r.text);
    if (parts.length) return parts.join('\n').slice(0, SCAN_MAX);
    try { return JSON.stringify(r).slice(0, SCAN_MAX); } catch { return ''; }
  }
  return '';
}

let out = '';
try {
  const payload = readPayload();
  const text = toolText(payload);
  // 自指抑制（2026-10-18 加）：输出里出现 `<!-- cue:` ⇒ 我在读**记忆库原文**，
  // 而 cue 的触发词就写在那条注释里 ⇒ 等于「用词表触发词表」，纯自指噪声
  // （实测：整天在改记忆库的那一天，读/搜记忆库几乎每次都触发，十几条噪注）。
  // 判据只认 `cue:` 而不是任意元数据：正常代码/日志里不会出现它，误伤面最小。
  const selfRef = /<!--\s*cue:/.test(text);
  if (text.length >= 4 && !selfRef) {
    const cwd = path.resolve(payload.cwd || process.env.CLAUDE_PROJECT_DIR || 'E:\\2');
    const dir = repoDir(slugOf(cwd));
    // 缓存已过期又写不进去时，loadCueTable 会用内存重建兜底（见 cue.mjs 头注释）
    const table = loadCueTable(dir, null);
    const hits = matchCues(table, text, 'output');
    const note = formatCueNote(hits);
    if (note) {
      out = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: note + '\n（这条是自动联想带出来的：你现在看到的东西里有触发词。无关就忽略。）',
        },
      });
    }
  }
} catch { /* 判据出错时不注入 —— 联想是加分项，永远不该打断主流程 */ }

// 不能 write 后立刻 exit（管道下会被截断）；未命中则静默退出
if (out) process.stdout.write(out, () => process.exit(0));
else process.exit(0);
