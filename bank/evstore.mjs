// ============================================================================
// Memory Bank · evstore —— 事件存储（SQLite，2026-10-26 立项）
//
// 为什么加这一层：现有 `pages/events.md` 是「一行一个事件」的纯文本，
//   全部能力只有"读出来给我看"。实测一个多月只写了 20 条、关联 11 条、
//   联想词靠手写标记 ⇒ **真正缺的不是检索算法，是事件根本没被当成实体记下来**。
//
// 设计三条（改动前先读）：
//   ① **md 仍是权威，库是视图**：`cli ev import` 从 events.md 全量重建，可随时重跑；
//      库里的写入暂不回流 md（M2 再做）。这样迁移失败最多丢"库"，不会丢记忆。
//   ② **raw 列保底**：每行原始文本原样存一份。解析器写错时还能从 raw 重新解析，不丢内容。
//   ③ **不用 better-sqlite3**：Node 24 自带 `node:sqlite`，零依赖、无编译。
//
// 表：events（事件）/ edges（事件→事件）/ entities（名词）/ event_entities（多对多）
// ============================================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DB_FILE = 'memory.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  at          TEXT,
  day         TEXT NOT NULL,
  slot        TEXT,
  brief       TEXT NOT NULL,
  detail      TEXT,
  kind        TEXT,
  source      TEXT,
  confidence  TEXT,
  importance  INTEGER DEFAULT 3,
  expires     TEXT,
  raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS edges (
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL,
  type     TEXT NOT NULL,
  note     TEXT,
  strength REAL DEFAULT 1.0,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);

CREATE TABLE IF NOT EXISTS entities (
  name TEXT PRIMARY KEY,
  kind TEXT,
  df   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event_entities (
  event_id TEXT NOT NULL,
  entity   TEXT NOT NULL,
  PRIMARY KEY (event_id, entity)
);
CREATE INDEX IF NOT EXISTS idx_ee_entity ON event_entities(entity);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

/** 打开（必要时创建）库。`dir` 是仓库目录（与 mood.json 同级）。 */
export function openDb(dir) {
  const file = path.join(dir, DB_FILE);
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** 解析 events.md：返回事件数组。格式见文件头（`## 日期` + `- [时段] 正文 <!-- 元数据 -->`）。 */
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

/**
 * 给**单条**事件补实体（2026-10-29）。
 *
 * 起因：`ev-autolog` 自动记事件时只 INSERT events、从不抽实体 ⇒ `event_entities` 从 2026-10-26
 * 起全为 0，「事件×事件」联想的判据（共享稀有实体 df∈[2,3]）对最近的事件彻底失效 ——
 * 而代码路径一切正常、测试也全绿，又一个「代码在跑 ≠ 这件事在做」。
 *
 * ⚠️ 抽词口径必须与下方 `importFromEventsMd` 里那段保持**完全一致**（都走 `extractEntities(brief)`）。
 *    改一边时记得看另一边 —— 两张表各抄一份判据的结果就是漂移，历史上已经栽过（MIN_SCORE 那次）。
 * @returns 这次关联到的实体个数
 */
export function linkEntities(db, eventId, brief) {
  const insEE = db.prepare('INSERT OR IGNORE INTO event_entities (event_id, entity) VALUES (?, ?)');
  const insEnt = db.prepare('INSERT OR REPLACE INTO entities (name, kind, df) VALUES (?, ?, ?)');
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM event_entities WHERE entity = ?');
  let n = 0;
  for (const name of extractEntities(brief)) {
    insEE.run(eventId, name);                                  // 先插关系
    insEnt.run(name, null, Number(cnt.get(name).c || 0));       // df 按**全库**重算，不是本批
    n += 1;
  }
  return n;
}

/** 全量导入（清空 events/edges/event_entities 后重建）。返回统计。 */
export function importFromEventsMd(db, repoDir) {
  const file = path.join(repoDir, 'pages', 'events.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const events = parseEventsMd(text);
  // ⚠️ 不能 `DELETE FROM events` 一把梭：`tick` 每轮自动记的 `kind='auto'` 事件也在同一张表里，
  //    全清会让"自动记录"白干（2026-10-26 写 autolog 时当场发现）。
  //    只清从 events.md 来的那批（kind 非 auto），并顺手清掉失去父事件的实体关系。
  db.exec(`DELETE FROM events WHERE COALESCE(kind, '') != 'auto';
    DELETE FROM event_entities WHERE event_id NOT IN (SELECT id FROM events);
    DELETE FROM edges;
    DELETE FROM entities WHERE name NOT IN (SELECT entity FROM event_entities);`);
  const insE = db.prepare(`INSERT INTO events (id, at, day, slot, brief, detail, kind, source, confidence, importance, expires, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const e of events) {
    // ⚠️ node:sqlite 的 run() 不接受 undefined（必须显式 null），漏一个就整批炸（本轮踩过）
    insE.run(e.id, e.at ?? null, e.day, e.slot ?? null, e.brief, e.detail ?? null, e.kind ?? null,
      e.source ?? null, e.confidence ?? null, e.importance, e.expires ?? null, e.raw);
  }
  // 实体（从简述里抽）
  const insEnt = db.prepare('INSERT OR REPLACE INTO entities (name, kind, df) VALUES (?, ?, ?)');
  const insEE = db.prepare('INSERT OR IGNORE INTO event_entities (event_id, entity) VALUES (?, ?)');
  const df = new Map();
  const pairs = [];
  for (const e of events) {
    for (const name of extractEntities(e.brief)) {
      df.set(name, (df.get(name) || 0) + 1);
      pairs.push([e.id, name]);
    }
  }
  for (const [name, n] of df) insEnt.run(name, null, n);
  for (const [id, name] of pairs) insEE.run(id, name);
  // rel: → edges（type='relates'，to_id 用「页面#关键词」这种伪 id，先不建实体）
  const insEdge = db.prepare('INSERT OR IGNORE INTO edges (from_id, to_id, type, note) VALUES (?, ?, ?, ?)');
  let relCount = 0;
  for (const e of events) {
    for (const rel of e.rels || []) {
      insEdge.run(e.id, rel, 'relates', 'events.md 里的 rel: 注释');
      relCount += 1;
    }
  }
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('importedAt', new Date().toISOString());
  db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('source', 'pages/events.md');
  return { events: events.length, entities: df.size, rels: relCount };
}

/**
 * 改一条事件（写 brief / detail / kind / importance…）。
 * 为什么需要它：autolog 只记「用户说了什么 + 用了哪些工具」—— **真正的概要得由会思考的那一方补**
 * （2026-10-26 的设计取舍是「规则不做摘要」，2026-10-27 用户拍板「概要由你写」）。
 */
export function updateEvent(db, id, patch = {}) {
  const allowed = ['brief', 'detail', 'kind', 'importance', 'source', 'confidence', 'expires'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (!(k in patch)) continue;
    sets.push(`${k} = ?`);
    vals.push(patch[k] ?? null);   // node:sqlite 不接受 undefined
  }
  if (!sets.length) return { ok: false, reason: `没有可改的字段（${allowed.join('/')}）` };
  vals.push(String(id));
  const info = db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: Number(info.changes || 0) > 0, changes: Number(info.changes || 0) };
}

/** 事件边的类型白名单（与 md 的 `rel:` 类型同源，见 bank.mjs 的 REL_TYPES）。 */
export const EVENT_EDGE_TYPES = ['causal', 'sequence', 'scenario', 'attribute', 'preference', 'relates'];

/** 建一条事件→事件的边（每日联想人审通过后落库）。 */
export function addEdge(db, from, to, { type = 'relates', note = '' } = {}) {
  if (!from || !to) return { ok: false, reason: '需要 from 和 to' };
  if (String(from) === String(to)) return { ok: false, reason: '自己连自己没意义' };
  if (!EVENT_EDGE_TYPES.includes(type)) return { ok: false, reason: `type 只能是 ${EVENT_EDGE_TYPES.join('/')}` };
  const info = db.prepare('INSERT OR IGNORE INTO edges (from_id, to_id, type, note) VALUES (?, ?, ?, ?)')
    .run(String(from), String(to), type, note || null);
  return { ok: true, inserted: Number(info.changes || 0) > 0 };
}

/** 删一条边（否决候选时用 —— 否则明天同一批还会被报出来）。 */
export function dropEdge(db, from, to) {
  const info = db.prepare('DELETE FROM edges WHERE from_id = ? AND to_id = ?').run(String(from), String(to));
  return { ok: true, removed: Number(info.changes || 0) };
}

/** 列表（按日期倒序）。 */
export function listEvents(db, { day = null, limit = 20 } = {}) {
  if (day) {
    return db.prepare('SELECT id, day, slot, brief, importance, source, confidence FROM events WHERE day = ? ORDER BY id').all(day).slice(0, limit);
  }
  return db.prepare('SELECT id, day, slot, brief, importance, source, confidence FROM events ORDER BY day DESC, id DESC LIMIT ?').all(limit);
}

/** 关键词搜索（简述 LIKE，M1 够用；M2 上 FTS5 或实体联查）。 */
export function searchEvents(db, kw, limit = 10) {
  const q = `%${String(kw)}%`;
  return db.prepare('SELECT id, day, brief FROM events WHERE brief LIKE ? OR raw LIKE ? ORDER BY day DESC LIMIT ?').all(q, q, limit);
}

/** 某事件的邻居（出边 + 入边）。 */
export function relatedEvents(db, id) {
  const out = db.prepare('SELECT from_id, to_id, type, note FROM edges WHERE from_id = ?').all(id);
  const back = db.prepare('SELECT from_id, to_id, type, note FROM edges WHERE to_id = ?').all(id);
  return { outgoing: out, incoming: back };
}

/** 按实体反查事件（这就是「联想」的底座：看到某个名字 → 想起哪些事）。 */
export function eventsByEntity(db, name, limit = 10) {
  return db.prepare(`SELECT e.id, e.day, e.brief FROM event_entities ee JOIN events e ON e.id = ee.event_id
    WHERE ee.entity = ? ORDER BY e.day DESC LIMIT ?`).all(name, limit);
}

/** 统计（给报告用）。 */
export function stats(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    events: one('SELECT COUNT(*) AS n FROM events').n,
    edges: one('SELECT COUNT(*) AS n FROM edges').n,
    entities: one('SELECT COUNT(*) AS n FROM entities').n,
    days: one('SELECT COUNT(DISTINCT day) AS n FROM events').n,
    importedAt: db.prepare('SELECT v FROM meta WHERE k = ?').get('importedAt')?.v || null,
  };
}
