// ============================================================================
// Memory Bank · recall-assemble —— 召回结果的**预算装配**（2026-11-08 从 search.mjs 按域拆出）
//   为什么单独一个文件：search.mjs 已 312 行、红线 290，而这段逻辑自带一整套踩坑史
//   （三个实测坑，见下），塞回去只能靠压缩注释 —— 那违反「只许瘦不许胖，超限先按域拆分」。
//   职责边界：只负责"把已排好序的命中装进 budget"，不做检索、不做打分、不写文件。
// ============================================================================
import { cutText } from './core.mjs';

/** 正文前缀下限（不含标题与标注）。低于它 ⇒ 连"这条在讲什么"都看不出来，不如跳过。 */
const MIN_ITEM = 60;
/** 降级标注。⚠️ 与 cutText 自带的「…（已截断，完整内容见对应文件）」**刻意不同**，便于测试区分两条路径。 */
const MARK = '\n…（截断，完整：cli page ';
/** cutText 真截断时自加的 '\n…（已截断，完整内容见对应文件）' 长度（16 字，实测）。 */
const CUT_MARK = 16;

/**
 * 预算感知降级（2026-11-08，借 LivingMemory 输出层：完整字段 → 精简字段 → 减条目 → 标 truncated）。
 *
 * 旧实现是「整条丢弃」（`if (used + seg.length > budget && lines.length > 1) continue;`）：
 *   实测 18 条相关提问 **18/18** 都有候选被整条丢掉，而且丢的时候预算常常没花完（743/1100、784/1100）
 *   —— 丢掉的额度既没给后面的条目，也没告诉模型"还有别的"。
 *
 * 新分配：第 i 条的前缀预算 = 剩余预算 / 剩余条数。短条目（实测 87~238 字）用不满自己的份额
 *   ⇒ 额度自动流给后面的长条目；长条目（实测 420~1430 字）被切成前缀 + 标注，而不是消失。
 *
 * ⚠️ 三个实测坑（都踩过，别再退回）：
 *   ① cutText 真截断时会**自己加 16 字标记** ⇒ 份额里要预留，否则总长超预算；
 *   ② 份额要**用满** —— 第一版减了两次 16，结果每轮白丢 16 字，反而比旧版多丢一条；
 *   ③ cutText 的**兜底分支**（找不到行边界 / 边界落在前半段）返回 `head.slice(0, n) + 标记`，
 *      可能**比 n 还长**（实测 60→77、80→97）⇒ "超了就丢这条"会误杀本该装下的条目，
 *      改成按超出量回退 avail 重构造。
 *
 * @param {Array} hits  已排序的命中（每项需有 kind/title/text/page）
 * @param {{budget:number, head?:string[], used?:number}} opts  head/used 用于已经写入的前缀（如全局偏好段）
 * @returns {{lines:string[], used:number}}
 */
export function assemble(hits, { budget, head = [], used: used0 = 0 } = {}) {
  const lines = [...head];
  let used = used0;
  const rest = hits.slice();
  for (let i = 0; i < rest.length; i++) {
    const h = rest[i];
    // ⚠️ 2026-09-15 修复（随本段一起搬来，别丢）：原先用 clip() 把所有换行压成空格，召回内容糊成一坨。
    //    同理 index.json 里存的 text 也不能用 clip（见 reindexPage），否则源头就没换行。
    const tag = `【${h.kind}｜${h.title}】\n`;
    const body = String(h.text || '');
    // ⚠️ 2026-11-08 实测：`cutText(body, 420)` 的结果可能**超过 420**（兜底分支是 slice(0,n)+16 字标记，
    //   实测 60→77、80→97）。旧代码 `full.length <= left` 用这个膨胀值判"装得下"⇒ 装得下的条目也走降级，
    //   于是本该走 cutText 自带标记的那几条**拿不到页名标注**（测试 ② 就是这么红的）。
    //   这里用**原始正文长度**判"要不要降级"，降级与否只看"全文放不放得下"，不看标记的长度抖动。
    const full = tag + cutText(body, 420);
    const left = budget - used;
    const remain = rest.length - i;
    if (body.length <= 420 && full.length <= left) { lines.push(full); used += full.length; continue; }
    // —— 装不下整条 ⇒ 按份额降级 ——
    const mark = `${MARK}${h.page}）`;
    const share = Math.floor(left / remain);
    let avail = share - tag.length - mark.length - CUT_MARK - 1;
    if (avail < MIN_ITEM) continue;   // 连前缀都放不下：整条跳过（不输出半截标题）
    let seg = tag + cutText(body, avail) + mark;
    for (let g = 0; g < 6 && used + seg.length > budget && avail > MIN_ITEM; g++) {
      avail -= (used + seg.length - budget) + 1;
      if (avail < MIN_ITEM) break;
      seg = tag + cutText(body, avail) + mark;
    }
    // 收不住 ⇒ 退到最小前缀（保底：至少让模型知道"这条存在、去哪看全文"）
    if (avail < MIN_ITEM || used + seg.length > budget) seg = tag + cutText(body, MIN_ITEM) + mark;
    if (used + seg.length <= budget) { lines.push(seg); used += seg.length; }
  }
  // —— 总闸（实测补）：上面每条只保证"自己放得下"，但 `join('\n')` 的连接符也占字数
  //   （实测 4 条 3 个换行 ⇒ 1103 = 1100 + 3）。装配完按**真实 join 长度**从尾部收，
  //   丢的都是份额最小的降级产物 —— 比让注入**每轮**都超预算划算。
  while (lines.length > 1 && lines.join('\n').length > budget) lines.pop();
  return { lines, used: lines.join('\n').length };
}
