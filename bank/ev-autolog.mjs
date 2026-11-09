// ============================================================================
// Memory Bank · ev-autolog —— 每轮收尾自动记一条事件（2026-10-26，用户拍板「先做①」）
//
// 为什么要有它：`pages/events.md` 靠我手写，实测**一个多月只写了 20 条**（109 条是历史存量里
//   有些藏在别的页面）。⇒ 「没记」才是记忆塌方的第一因，检索算法排第二。这个模块只干一件事：
//   **从最近一轮会话里抽出一条原始事件，写进 SQLite**，不给它"解释"的权力。
//
// 设计取舍（改动前先读）：
//   ① **只记原始事实**：`用户：<原话首 60 字> → 工具：<名字列表>`。
//      不做摘要、不判断重要性 —— 规则做不到"理解"，硬做会造出一堆假因果（比不记更糟）。
//   ② **幂等**：同一轮重复跑（tick 可能被触发多次）不会重复插，靠 `seq` 做 id 后缀 + INSERT OR IGNORE。
//   ③ **失败不抛**：tick 的 step() 会兜，但这里也自己兜一层 —— 记账模块不该拖垮收尾流程。
//   ④ **不写 md**：只进库。md 是"人读的叙事"，库是"机器查的结构"，两者先不要互相污染。
// ============================================================================
import { findTranscripts, readRecords, readJson, writeJson, textOf } from './core.mjs';
import { linkEntities, openDb } from './evstore.mjs';
import fs from 'node:fs';
import path from 'node:path';

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

/**
 * ev 的指纹判断（抽成纯函数，便于测试）。
 * ⚠️ **独立于 ingest 的 `state.stamps`**：ingest 跑在 ev 前面会抢先更新那个键，
 *   共用的话 ev 第一次就误判「已抽过」、事件永远不落库（2026-11-09 真实踩到）。
 *   ev 用自己的 `state/ev-stamp.json`，键 = 会话目录名，值 = `size:mtimeMs`。
 * @returns {{skip:boolean, fp:string|null, key:string}}
 */
export function evShouldSkip(dir, file) {
  const key = path.basename(path.dirname(file));
  let st;
  try { st = fs.statSync(file); } catch { return { skip: false, fp: null, key }; }
  const fp = `${st.size}:${st.mtimeMs}`;
  try {
    const evStamps = readJson(path.join(dir, 'state', 'ev-stamp.json'), {});
    if (evStamps[key] === fp) return { skip: true, fp, key };
  } catch { /* 读不到就当没跳过 */ }
  return { skip: false, fp, key };
}

const slotOf = (d) => {
  const h = d.getHours();
  if (h < 5) return '凌晨';
  if (h < 8) return '早晨';
  if (h < 11) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 22) return '晚上';
  return '深夜';
};

/**
 * 从最近一轮抽事件写库。
 * @returns {{ok:boolean, reason?:string, event?:object}}
 */
export function autoLogEvent(dir, { cwd, maxTools = 6, maxChars = 60 } = {}) {
  try {
    const files = findTranscripts(cwd || process.cwd());
    if (!files.length) return { ok: false, reason: '没有找到会话日志' };
    // —— 指纹跳过（2026-11-09，A 组调研实测）：ev 和 ingest **同款病** ——
    //   同一份最新日志一轮 tick 被解压两次（ingest 先解、ev 再解，实测 140ms）。
    //   指纹判断抽在 `evShouldSkip`（纯函数，独立于 ingest 的 state.stamps）。
    const file = files[0].file;
    const chk = evShouldSkip(dir, file);
    if (chk.skip) return { ok: true, skipped: true, reason: '事件已抽取（文件没变），跳过解压' };
    const fp = chk.fp;
    const recs = readRecords(file);
    if (!recs.length) return { ok: false, reason: '会话日志为空' };

    // ⚠️ 会话里 user/message 的形状是 `data:{role, content, source}`，**不是** `data.message.content`
    //    （2026-10-26 照 assistant/message 的形状写，结果 textOf(undefined) 恒空、autolog 全程静默）
    let ui = -1;
    for (let i = recs.length - 1; i >= 0; i -= 1) {
      const r = recs[i];
      if (r.type !== 'user/message') continue;
      const sk = r.data?.source?.kind;
      if (sk && sk !== 'user') continue;   // 插件注入的不是主人说的话
      ui = i;
      break;
    }
    if (ui < 0) return { ok: false, reason: '最近没有主人消息' };

    const u = recs[ui];
    const text = textOf(u.data?.content) || '';
    if (!text.trim()) return { ok: false, reason: '主人消息没有文本（可能是纯图片）' };

    // 这一轮之后调用了哪些工具（去重、保序）
    const tools = [];
    for (let i = ui + 1; i < recs.length; i += 1) {
      const r = recs[i];
      if (r.type === 'tool/call' && r.data?.name && !tools.includes(r.data.name)) tools.push(r.data.name);
    }

    const at = new Date(u.time || Date.now());
    const day = at.toISOString().slice(0, 10);
    const seq = Number(u.seq || recs.length);
    const id = `ev-${day}-${String(seq).padStart(5, '0')}`;
    const brief = `主人：${clip(text, maxChars)}${tools.length ? ` → 工具：${tools.slice(0, maxTools).join('/')}` : ''}`;

    // —— detail：**完整事件**（2026-10-27 用户拍板「完整事件像上下文一样存储，概要由我写」）——
    //    brief 只留 60 字：够检索、不够还原。detail 存「用户原话全文 + 工具 + 我这一步的回复头」，
    //    让人能凭它复述当时发生了什么。
    //    ⚠️ 用户原话**不截断**（那是事实源）；只截我的回复（400 字，防库膨胀）。
    //    ⚠️ 概要（brief）仍由 `cli ev note <id> --brief "…"` **由我重写** —— 这里的 brief 只是兜底流水。
    let reply = '';
    for (let i = ui + 1; i < recs.length; i += 1) {
      const r = recs[i];
      if (r.type !== 'assistant/message') continue;
      const t = textOf(r.data?.message?.content) || '';
      if (t.trim()) { reply = clip(t, 400); break; }   // 只要第一条有正文的回复
    }
    const detail = [
      `主人：${text}`,
      tools.length ? `工具：${tools.join(' / ')}` : '',
      reply ? `我：${reply}` : '',
    ].filter(Boolean).join('\n→ ');

    const db = openDb(dir);
    try {
      const ins = db.prepare(`INSERT OR IGNORE INTO events (id, at, day, slot, brief, detail, kind, source, confidence, importance, expires, raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const info = ins.run(id, at.toISOString(), day, slotOf(at), brief, detail, 'auto', 'probe', 'high', 2, null, null);
      const inserted = Number(info.changes || 0) > 0;
      // 2026-10-29：补上实体关联 —— 此前只写 events，`event_entities` 从 10-26 起全是 0。
      const entities = inserted ? linkEntities(db, id, brief) : 0;
      // 抽取成功才记指纹（2026-11-09）：下次文件没变就跳过解压。失败不写 ⇒ 下次照常重试。
      if (fp) {
        try {
          const evStamps = readJson(path.join(dir, 'state', 'ev-stamp.json'), {});
          evStamps[chk.key] = fp;
          writeJson(path.join(dir, 'state', 'ev-stamp.json'), evStamps);
        } catch { /* 记不上指纹只是下次多解压一次，不拖垮 */ }
      }
      return { ok: true, inserted, entities, event: { id, day, slot: slotOf(at), brief } };
    } finally {
      try { db.close(); } catch {}
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}
