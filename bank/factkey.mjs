// ============================================================================
// factkey —— 「事实键」：给同一条事实的多次更新自动建立 supersede 关系
//
// 为什么（2026-11-02 立项，来源 dsh-fish-memory 的 fact key 机制）：
//   `supersededBy` 这个 meta **早就存在且已生效**（`search.mjs` 里 ×0.25 降权、
//   `assoc/cue` 里直接跳过），但**没有任何建立关系的入口** ——
//   要标记"这条已被那条取代"，只能人肉去页里写 `<!-- sup:某某 -->`，等于机制空转。
//
// 键的格式：`对象.方面`（如 `她.身高`、`我.作息`）。
//   ⚠️ **键里绝对不许写值** —— 写 `她.身高`，不写 `她.身高170`。
//   理由：值一变化键就跟着变，新旧两条永远碰不上，机制当场失效。
//   这是 fish-memory 的原话教训，我原样吸收。
//
// 语义：**同一个键 = 同一件事** ⇒ 只留最新那条有效，旧条自动标 `supersededBy`。
//   「最新」怎么定义：按**写入顺序**（页内行号 later = 新），不看正文里的日期 ——
//   因为 `remember` 每次都追加到页尾，行号天然单调。
// ============================================================================
import path from 'node:path';
import { pageBlocks, parseMeta, readText, writeText } from './core.mjs';

/** 键的合法形状：`对象.方面`，两段都非空、不含空白。
 *  ⚠️ 只校验「形状」，不校验「值有没有混进来」—— 那需要业务知识，机器猜不出来，
 *  改为在 CLI 帮助里用大字警告（见 cli 的 --key 说明）。 */
export const FACT_KEY_RE = /^[^\s.]+\.[^\s.]+$/;

/**
 * 在一页里找出某个事实键的所有条目块，返回它们在 `lines` 里的行区间。
 * 判断依据是条目的 meta `key:<键>`（`parseMeta` 只认注释里的 `键:值`）。
 * @param {string[]} lines 整个页按 `\n` 切开
 * @param {string} key 事实键
 * @returns {Array<{s:number,e:number,full:string,hasSup:boolean}>}
 */
export function findFactKeyBlocks(lines, key) {
  const out = [];
  for (const b of pageBlocks(lines)) {
    // 块尾可能带一行空行（pageBlocks 的 e 是"最后一个续行"），这里按 s..e 原样切
    const full = lines.slice(b.s, b.e + 1).join('\n');
    const { meta } = parseMeta(full);
    // parseMeta 目前不认 `key`（core 的 META_KEYS 没有它）⇒ 自己从注释里抠，
    // 这样不用为加一个 meta 键去动 core.mjs（它 96% 预算、且改动面大）。
    const m = full.match(/<!--[\s\S]*?\bkey:([^\s]+)[\s\S]*?-->/);
    if (!m || m[1] !== key) continue;
    out.push({ s: b.s, e: b.e, full, hasSup: !!meta.supersededBy });
  }
  return out;
}

/**
 * 把页里 `key` 的**除最后一条外**全部标上 `supersededBy`。
 * 纯函数（不写盘）—— 返回新文本与改动清单，便于干跑预览与测试。
 *
 * 已带 `sup` 的条目**跳过**：那是人工判断过的（可能人为想保留两条），别机器覆盖。
 * @param {string} text 整页文本
 * @param {string} key 事实键
 * @returns {{text:string, superseded:string[], kept:string|null}}
 */
export function markSuperseded(text, key) {
  const lines = text.split('\n');
  const blocks = findFactKeyBlocks(lines, key);
  if (blocks.length < 2) return { text, superseded: [], kept: blocks.length ? blocks[0].full : null };
  const newest = blocks[blocks.length - 1];
  const superseded = [];
  // 从后往前改，避免行号位移（虽然我们是按块重建而不是逐行插删）
  const drop = new Set();
  for (const b of blocks.slice(0, -1)) {
    if (b.hasSup) continue;               // 人工标过的不动
    superseded.push(b.full);
    drop.add(b.s);
    drop.add(b.e);
  }
  if (!superseded.length) return { text, superseded: [], kept: newest.full };
  for (const b of blocks.slice(0, -1)) {
    if (b.hasSup) continue;
    // 在该块**首行末尾**追加注释（放在首行，缩进续行仍是同一块的续行）
    lines[b.s] = `${lines[b.s].replace(/\s+$/, '')} <!-- sup:${key} -->`;
  }
  return { text: lines.join('\n'), superseded, kept: newest.full };
}
