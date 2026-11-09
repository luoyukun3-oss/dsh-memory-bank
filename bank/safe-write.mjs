// ============================================================================
// Memory Bank · 并发安全的「读-改-写」（2026-11-08）
//
// 起因：GitHub 讨论区一条回复指出 ——
//   「后台整理读完一页后，用户又手动改了，最终以哪版为准？如果还没处理，
//     写回前比一下内容哈希，变了就重新读，能避免整理结果覆盖刚写下的纠正。」
//
// 实测复现（本轮跑的，不是推测）：模拟 bank.mjs 的 sync 写法
//   （readText 全文 → 替换一节 → writeText 全文），中间插入一次用户手改：
//     [后台] 已读完（拿到快照）
//     [用户] 手动改了节B
//     [后台] 在快照上改节A → 写回
//     ⇒ 用户那次编辑 **被静默覆盖**，且没有任何提示。
//   加写前比对后：指纹不一致 ⇒ 拒绝静默覆盖 ⇒ 重读重做 ⇒ 用户编辑保住、整理也生效。
//
// ⚠️ 只比 hash 不够（本文件的设计要点）：
//   若两次读之间文件被改了两次又刚好改回原样（编辑器保存触发的格式归一化、
//   行尾 CRLF↔LF 转换等），hash 会一致但语义可能已变。
//   ⇒ 所以 `mutatePage` 除了比指纹，还要求调用方给出「我期望的旧值」，
//     重读后**再确认一次那个旧值还在**，双重确认才写。
//
// ⚠️ 本文件必须保持零依赖（只用 node: 内建），且不许 import bank.mjs（循环依赖）。
// ============================================================================
import fs from 'node:fs';
import { createHash } from 'node:crypto';

/** 内容指纹（sha1 前 16 位）：用于「读完之后有没有人改过」的判据 */
export const fingerprintOf = (text) => createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);

/**
 * 并发安全的「读 → 改 → 写」。
 *
 * @param {string} file 目标文件
 * @param {(text: string) => string | null} mutate 纯函数：拿到**最新**全文，返回新全文；
 *        返回 null / 原样字符串 表示「无需改动」（不会写盘）
 * @param {object} [opts]
 * @param {number} [opts.retries=2] 检测到并发修改时最多重做几次
 * @param {(info:{file:string,attempt:number,oldFp:string,newFp:string}) => void} [opts.onConflict]
 *        每次检测到冲突时回调（用于打日志/上报，默认静默）
 * @returns {{written:boolean, retries:number, reason:string, text:string}}
 *          written=false 时 reason 说明为什么没写（`no-change` / `conflict-give-up` / `not-found`）
 */
export function mutateFile(file, mutate, { retries = 2, onConflict } = {}) {
  let attempt = 0;
  let last = { text: '', fp: '' };
  while (attempt <= retries) {
    // ① 每次尝试都**重新读**，绝不复用上一轮的快照
    let before;
    try { before = fs.readFileSync(file, 'utf8'); } catch { before = null; }
    if (before === null) return { written: false, retries: attempt, reason: 'not-found', text: '' };
    const fpBefore = fingerprintOf(before);
    last = { text: before, fp: fpBefore };

    // ② 在最新内容上改
    const after = mutate(before);
    if (after === null || after === undefined || after === before) {
      return { written: false, retries: attempt, reason: 'no-change', text: before };
    }

    // ③ 写前**再读一次**比指纹 —— 这是整个机制的核心
    let now;
    try { now = fs.readFileSync(file, 'utf8'); } catch { now = null; }
    if (now === null) return { written: false, retries: attempt, reason: 'not-found', text: before };
    const fpNow = fingerprintOf(now);
    if (fpNow !== fpBefore) {
      // 读完之后有人改过 ⇒ 这一轮的结果基于过期快照，**丢弃并重做**
      if (onConflict) onConflict({ file, attempt: attempt + 1, oldFp: fpBefore, newFp: fpNow });
      attempt++;
      continue;
    }

    // ④ 指纹一致 ⇒ 安全写回
    fs.mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    fs.writeFileSync(file, after, 'utf8');
    return { written: true, retries: attempt, reason: 'ok', text: after };
  }
  return { written: false, retries: attempt, reason: 'conflict-give-up', text: last.text };
}

/**
 * 便捷封装：改「页面里某一节」—— 语义上等价于 bank.mjs sync 的「替换一节」。
 * 额外做**第二重确认**：重读后要确认目标节的旧内容仍是调用方期望的那份。
 *
 * @param {string} file 页面文件
 * @param {string} oldSection 期望被替换的旧节全文（必须能在最新内容里找到）
 * @param {string} newSection 新节全文
 * @param {object} [opts] 透传给 mutateFile
 */
export function replaceSectionSafely(file, oldSection, newSection, opts = {}) {
  let sawOld = false;
  const res = mutateFile(file, (text) => {
    // 每次重读后都重新确认「旧节还在」，防止基于过期判断覆盖
    if (!text.includes(oldSection)) { sawOld = false; return null; }
    sawOld = true;
    return text.replace(oldSection, () => newSection);
  }, opts);
  if (!res.written && res.reason === 'no-change' && !sawOld) {
    return { ...res, reason: 'target-missing' };
  }
  return res;
}
