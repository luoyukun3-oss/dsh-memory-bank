// ============================================================================
// Memory Bank · 每轮召回与联想（2026-11-09 从 hooks/user-prompt.mjs 按域拆出）
//   为什么拆：user-prompt.mjs 实测 168 / 预算 170（99%）逼近红线，按「超限先按域拆、别压缩行宽硬塞」处理。
//   边界很干净：本文件**只产出文本**（召回块 / 低分路标 / 触发式联想），
//   决定了往哪儿放（parts 数组的顺序、HARD 排最前）留在 user-prompt.mjs —— 那是注入契约。
//   ⚠️ `h.score >= MIN_SCORE` 的**强命中过滤仍留在 user-prompt.mjs**（不要挪进来）：
//      test-mood.mjs 有一条源码守护断言「hook 注入触发只认 score（情绪不得绕过 INJECT_MIN_SCORE）」，
//      它读 user-prompt.mjs 的源码找这行；挪走会让那条守护静默失效。
// ============================================================================
import { recall } from '../bank.mjs';
import { INJECT_MIN_SCORE } from '../config-keys.mjs';
import { bumpAccess } from '../core.mjs';
import { formatCueNote, loadCueTable, matchCues } from '../cue.mjs';
import { MEM_ROOT } from '../live.mjs';
import { planExpansion, readPrevUserMsg } from './query-expand.mjs';   // 短查询接续扩展（⑪，2026-11-08）

const MIN_SCORE = INJECT_MIN_SCORE;

/** 召回一个提问：先试扩展版、没有强命中就退回原句版。
 *  返回 { hits, text }；text 是召回正文（可能为空），hits 是排序后的命中（可能为空数组）。
 *  ⚠️ 这里**不做** strong 过滤（见文件头），也不决定注不注入。 */
export function runRecall({ dir, prompt, sessionId, warn = () => {} }) {
  // —— 短查询接续扩展（⑪，2026-11-08）：判定/拼接在 hooks/query-expand.mjs（头注释里有「为什么
  //   能读到上一轮」与查证结论）。这里是「先扩展、后降级」：扩展版**没有强命中**就退回原句版
  //   ⇒ 扩展不成时行为与改前逐字一致（连 bump 都是同一次）。
  //   降级判据刻意**不比较两个分数**（那要先跑原句版）；这里只看扩展版自己够不够 MIN_SCORE。
  //   ⚠️ 扩展路径两次召回都关 touch，最后对**采纳的** hit 补一次 bumpAccess（它自带容错，见 core.mjs:218）。
  const plan = planExpansion(prompt, readPrevUserMsg(MEM_ROOT, sessionId));
  let hits = null; let text = '';
  if (plan) {
    try {
      ({ hits, text } = recall(dir, plan.query, { k: 4, budget: 1100, touch: false, withGlobal: false }));
      if (!hits.some((h) => h.score >= MIN_SCORE)) {
        ({ hits, text } = recall(dir, prompt, { k: 4, budget: 1100, touch: false, withGlobal: false }));
      }
      bumpAccess(dir, hits.map((h) => h.id));
    } catch (e) {
      warn(`扩展召回失败，退回原句：${e.message}`);
      hits = null;
    }
  }
  if (!hits) ({ hits, text } = recall(dir, prompt, { k: 4, budget: 1100, touch: true, withGlobal: false }));
  // —— HITS 通道：hook 写不了文件，但 stderr 会被原样记进会话日志的 `hook/result.stderrSummary`
  //    ⇒ 唯一持久通道，供 ingest 累计「共现」（自动联想的数据基础）。格式固定 `HITS:` 前缀，只记标识。
  if (hits.length) warn(`HITS:${hits.map((h) => h.id || h.page).join(',')}`);
  return { hits, text };
}

/** 低分不装懂（2026-11-08，主人：「我说的都很模糊，向量也救不了」）：
 *   过去是**静默丢弃** —— 低于 MIN_SCORE 就不注入、也不吭声，等于系统假装没这回事。
 *   现在改为：有候选但都不够确信时，给一行**路标**（不提正文，只说"接近的有 X"，省预算）。
 *  ⚠️ 下限 NEAR_FLOOR 必须**高于噪声地板**：recall-eval 实测无关提问最高分 **0.91**
 *    （「今天天气怎么样」0.73、「一加一等于几」0.66）。第一版我写 0.6，实测把这两条
 *    也判成"接近"并注入路标 —— 纯属啰嗦。取 0.95（比地板高 0.04 留余量）。
 *  ⚠️ 只列**页名**不列条目：页名是稳定坐标，条目 id 会随行号漂移（见 lessons E 节）。
 *  没有任何够接近的页时返回空串（= 什么也不注入）。 */
export function nearNoteOf(hits) {
  const NEAR_FLOOR = 0.95;
  const near = [...new Set((hits || []).filter((h) => h.score >= NEAR_FLOOR).map((h) => h.page))].slice(0, 3);
  if (!near.length) return '';
  return `（记忆银行：**没找到确切记录**。接近的页：${near.join('、')} —— 要细查用 \`recall\`；若我答得含糊，请直接说「不是这个」）`;
}

/** 触发式联想（2026-10-13）：**刻意不看主命中的分数** —— 命中触发词就带出来。
 *  这是用户的要求（"看到乱码就想到编码格式"）：条件反射不该等别的事先被想起来。
 *  ⚠️ 它绕过了 MIN_SCORE 这道噪声防线，代价靠**词表**控制（df 门 + 人工 cue 标注），
 *  不是靠分数 —— 词表跑偏了要改词表，别在这里加分数门槛，那会让它退回 assoc 那种"搭车"形态。
 *  2026-11-07 加「教训命中计数」：cue 命中的条目 id 也 bump 进 access.json ——
 *  此前只有主召回计数，cue 这条「教训被看见」的主通道完全没记录，
 *  trial 质控（长期 0 命中 → 哑弹候选）会因此误判。bumpAccess 自带容错，失败不影响注入。 */
export function cueNoteOf(dir, prompt) {
  try {
    const cueHits = matchCues(loadCueTable(dir, null), prompt, 'prompt');
    const note = formatCueNote(cueHits);
    if (cueHits.length) bumpAccess(dir, cueHits.map((h) => h.id));
    return note;
  } catch { return ''; /* 联想失败不拖累召回 */ }
}
