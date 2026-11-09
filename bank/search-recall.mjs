// ============================================================================
// Memory Bank · search-recall —— 「召回」层（2026-11-09 从 search.mjs 按域拆出）
//   为什么拆：search.mjs 实测 289/290 行（100%，下一条改动就爆）。按预算表规矩按域拆。
//   分工：search.mjs 管**打分**（谁相关、多少分）；本文件管**取舍**（门槛、自命中过滤、
//         全局偏好头、预算装配、复述效应）—— 即「从命中到能塞进上下文的文本」这一段。
//   ⚠️ 单向依赖：本文件 import search()；search.mjs **不**反过来 import 本文件（无循环）。
//   ⚠️ 对外零变化：search.mjs 用 `export { searchDetailed, recall } from ...` 转发。
// ============================================================================
import path from 'node:path';
import {
  GLOBAL_SLUG, bumpAccess, cutText, readText, repoDir, stripFirstHeading, tokenize,
} from './core.mjs';
import { assemble } from './recall-assemble.mjs';   // 预算装配（2026-11-08 按域拆出）
import { search } from './search.mjs';

// ---------------------------------------------------------------- 召回
/** 理由层入口。⚠️ 2026-10-05 事故：原实现随 search.mjs 今天版本一起丢失（误回滚），
 *  而 bank.mjs 的对外接口仍导出它、且全库暂无调用者 ⇒ 先以转发兜底，保证记忆银行能跑。
 *  待办：确认原语义（应返回带"为什么命中"的理由）后补回。 */
export function searchDetailed(dir, query, opts = {}) {
  return search(dir, query, opts.k ?? 5);
}
export function recall(dir, query, { k = 5, budget = 1500, minScore = 0.45, touch = false, dedupeSelf = true, wantTrace = false, withGlobal = true } = {}) {
  // 2026-09-15：加 minScore 过滤 —— 宁可返回"没找到"，也别把低分噪声塞进上下文
  // 自命中过滤（2026-09-15）：journal 里存着用户的**原话**，拿提问去搜必然命中「自己」——
  // 把用户刚说的话当「记忆」还回去，零信息量还白占注入预算（实测 top 分数 41.6 全是自命中，
  // 那个 100% 的"命中率"因此是虚高的）。
  // 判据用**覆盖率**（查询词有多少落在该片段里）而不是 Jaccard —— 流水片段带着时间戳与
  // `**[用户]**` 标记，这些额外 token 会把 Jaccard 稀释掉，短查询就漏过去了。
  // 只对 `kind: 'journal'` 生效，知识页条目不受影响（免得「闰年判断」这种查询把同名知识条目误杀）；
  // 长提问（>60 字，多为粘贴的整段代码/长句）用更松的阈值。
  let hits = search(dir, query, k * 3).filter((h) => h.score >= minScore);
  // 2026-10-21：默认排除 journal（流水是原料、不是知识）。原先只靠 dedupeSelf 的覆盖率过滤，
  //   实测覆盖率 75% 的流水片段能漏过去并抢 top-1（「循环次数不能填小数」→ journal 1.51）。
  //   要流水（问「今天做了什么」）时传 wantTrace: true。
  if (!wantTrace) hits = hits.filter((h) => h.kind !== 'journal');
  if (dedupeSelf) {
    const qset = new Set(tokenize(query));
    const thr = String(query).length > 60 ? 0.6 : 0.8;
    hits = hits.filter((h) => {
      // 2026-09-15 修正：原先只过滤 `kind === 'journal'`，**放过了 `inbox.md`** ——
      // 实测「电脑变慢 界面发钝 风扇一直响」的 top-1 正是一条任务提示词（覆盖 10/10、2.26 分）。
      // 2026-09-16 起 `inbox.md` 已在**打分阶段直接 `continue` 排除**（见该处注释），
      // 这里的 `h.page === 'inbox.md'` 保留为**第二道防线**；痕迹页按同一把尺子过滤。
      const isTrace = h.kind === 'journal' || h.page === 'inbox.md';
      if (!isTrace || !qset.size) return true;
      const tset = new Set(tokenize(h.text));
      let inter = 0;
      for (const t of qset) if (tset.has(t)) inter++;
      return inter / qset.size < thr;
    });
  }
  hits = hits.slice(0, k);
  const gdir = repoDir(GLOBAL_SLUG);
  const gt = readText(path.join(gdir, 'pages', 'preferences.md'));
  const lines = [];
  let used = 0;
  // 2026-11-08：`withGlobal=false` 供 **hook 每轮召回** 使用 —— 开场注入（bootstrap）已经带了
  //   **完整**全局偏好（1763 字、永不截断），hook 每轮再带一次前 400 字纯属重复，
  //   而且它吃掉 budget=1100 里的 400（真正命中只剩 700）。
  //   ⚠️ 默认仍是 true：`cli recall` 这类**用户主动查**的场景，带上偏好有参考价值。
  if (withGlobal && gt.trim()) {
    const g = '【全局偏好】\n' + cutText(stripFirstHeading(gt), 400);
    lines.push(g);
    used += g.length;
  }
  // —— 预算感知降级（2026-11-08）：装配逻辑按域拆到 recall-assemble.mjs（本文件有 290 行红线）。
  //   旧实现在这里「整条丢弃」，实测 18/18 条相关提问都有候选被丢、且丢时预算没花完；
  //   新实现按份额降级 + 标 truncated，踩过的三个坑全写在那个文件头注释里。
  const { lines: outLines } = assemble(hits, { budget, head: lines, used });
  lines.length = 0;
  lines.push(...outLines);
  // 复述效应（2026-09-15）：命中即刷新访问时间，让「用过的记忆」下次更容易被想起
  if (touch) bumpAccess(dir, hits.map((h) => h.id));
  return { hits, text: lines.join('\n') };
}

// ---- 会话启动摘要已迁至 bootstrap.mjs；任何注入文本都**禁用 clip()**（压平换行=结构尽毁，2026-09-14 修过）
