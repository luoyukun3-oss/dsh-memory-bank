// ============================================================================
// Memory Bank · evstore-parse —— events.md 解析 + 实体抽取（2026-11-09 从 evstore.mjs 按域拆出）
//
// 为什么拆：evstore.mjs **294/300（98%）**逼近红线；这一域是「纯文本 → 结构」，**不 import
//   node:sqlite**，所以能单独跑、单独改、单独测。
//
// ⚠️ extractEntities 的抽词口径是「事件×事件」联想的判据来源 —— 全库只留这**一份**实现。
//   谁再抄一份，df 统计就会漂移（历史上 MIN_SCORE 抄两份就漂过一次）。
// ============================================================================

export function parseEventsMd(text) {
  const out = [];
  let day = null;
  let idx = 0;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const h = rawLine.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (h) { day = h[1]; idx = 0; continue; }
    const m = rawLine.match(/^-\s+(?:\[([^\]]+)\]\s*)?(.+)$/);
    if (!m || !day) continue;
    idx += 1;
    const slotRaw = (m[1] || '').trim();
    const body = m[2] || '';
    // ⚠️ 实测 events.md 的真实形状比头注释说的更乱：
    //   ① 全文只有 `## 2026-09-15` 一个日期节，后面的事件把真实日期写在**正文开头**（"2026-10-13 【…】"）
    //   ② `[user/high]` 是「来源/置信度」的简写，不是时段
    //   解析器必须两边都认，否则 days 会算成 1、slot 里会塞进 user/high（本轮实测打脸）。
    const dateInBody = body.match(/^(\d{4}-\d{2}-\d{2})\s*/);
    const evDay = dateInBody ? dateInBody[1] : day;
    const bodyNoDate = dateInBody ? body.slice(dateInBody[0].length) : body;
    const isSlot = /上午|中午|下午|晚上|深夜|凌晨|早晨|傍晚/.test(slotRaw);
    const slot = isSlot ? slotRaw : null;
    const slotAsMeta = !isSlot && slotRaw ? slotRaw : null;   // 形如 user/high
    // 行尾 HTML 注释里的元数据（i/s/c/x）与 rel:（指向其他页面的关联）
    const meta = body.match(/<!--([\s\S]*?)-->\s*$/);
    const comment = meta ? meta[1] : '';
    const brief = bodyNoDate.replace(/<!--[\s\S]*?-->\s*$/, '').trim();
    const pick = (k) => {
      const r = comment.match(new RegExp(`${k}:\\s*([^\\s]+)`));
      return r ? r[1].trim() : null;
    };
    const im = pick('i');
    const importance = im ? Number(String(im).split('-')[0]) : 3;
    const metaParts = slotAsMeta ? slotAsMeta.split('/') : [];
    out.push({
      id: `ev-${evDay}-${String(idx).padStart(2, '0')}`,
      day: evDay, slot, brief,
      detail: null,
      kind: null,
      source: pick('s') || metaParts[0] || null,
      confidence: pick('c') || metaParts[1] || null,
      importance: Number.isFinite(importance) ? importance : 3,
      expires: pick('x'),
      raw: rawLine.trim(),
      rels: [...comment.matchAll(/rel:([^\s,;]+)/g)].map((r) => r[1]),
    });
  }
  return out;
}

/** 从事件正文里抽「实体」：文件名、工具名、疑似专名。刻意保守 —— 宁可少抽，不要噪音。 */
export function extractEntities(text) {
  const t = String(text || '');
  const found = new Set();
  // 文件名 / 路径末段（如 mood.mjs、events.md、tick.mjs）
  for (const m of t.matchAll(/[A-Za-z0-9_@-]+\.(?:mjs|js|ts|py|json|md|yml|yaml|onnx|exe|zip|log)\b/g)) {
    found.add(m[0]);
  }
  // 反引号里的名字（`cli mood set` → cli / mood 太碎，只留整体）
  for (const m of t.matchAll(/`([^`]{2,40})`/g)) {
    const v = m[1].trim();
    if (v && !/\s/.test(v)) found.add(v);
  }
  // 形如 dsh-xxx / ev-xxx / evstore 这类连字符标识
  for (const m of t.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+){1,3}\b/g)) {
    found.add(m[0]);
  }
  return [...found].slice(0, 12);
}
