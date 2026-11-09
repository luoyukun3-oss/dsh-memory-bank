// ============================================================================
// Memory Bank · evstore-schema —— 事件库的「骨架」（2026-11-09 从 evstore.mjs 按域拆出）
//
// 为什么拆：evstore.mjs 实测 **294/300（98%）**，逼近 budgets.json 的架构红线；按项目原则
//   「只许瘦不许胖，超限先按域拆，别压缩行宽硬塞」。这一域只装库的骨架：DDL 与 openDb ——
//   零业务、零解析，谁改表结构只看这一个文件。
//
// 设计三条（改动前先读，摘自 evstore.mjs 头注释）：
//   ① **md 仍是权威，库是视图**：cli ev import 从 events.md 全量重建，可随时重跑；
//      库里的写入暂不回流 md（M2 再做）。迁移失败最多丢"库"，不会丢记忆。
//   ② **raw 列保底**：每行原始文本原样存一份。解析器写错时还能从 raw 重新解析，不丢内容。
//   ③ **不用 better-sqlite3**：Node 24 自带 node:sqlite，零依赖、无编译。
//
// 表：events（事件）/ edges（事件→事件）/ entities（名词）/ event_entities（多对多）/ meta
// ============================================================================
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
