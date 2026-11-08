// ============================================================================
// Memory Bank · dream-events —— 「事件 × 事件」的意外关联（2026-10-27 用户要求：
//   「事件联想这个正好也加入每日联想里」）
//
// 为什么要单独一个域：`findDreamPairs` 只扫 `index.json` 里的 **pages 条目**，而事件在
//   `memory.db` —— 两套存储、两种失败面（库坏了不该让条目联想整段挂掉）。
//   按域拆开，dream.mjs 只调一行、只多几行渲染（那边 199/220，禁不起再长）。
//
// 判据沿用条目对的两个思路（不是新发明）：
//   ① 共享**稀有实体**才算意外关联 —— df 高的实体（`deepseek-ai` df=9、`gh-my-posts` df=7）
//      到处都出现，拿它当关联等于说「这两条都提到了 DSH」；
//   ② **同一天的事件不配对** —— 那是"同一件事的流水记录"，不是意外关联
//      （同 dream.mjs 的 same-event 分层：同日/相邻的另放 `--near`）。
//   ⚠️ 与条目对**刻意不同**的一点：事件没有 tags/rel 字段，所以不做「无共享标签」那道判断。
// ============================================================================
import { openDb } from './evstore.mjs';

const RARE_DF = 3;      // 实体最多出现在 3 个事件里才算「稀有」
const MIN_SHARED = 2;   // 至少共享 2 个稀有实体（只共享 1 个太容易是巧合）
const LIMIT = 5;

const fp = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * 找「共享稀有实体」的事件对。
 * @returns {{total:number, rareEntities:number, candidates:Array, reason?:string}}
 */
export function findEventPairs(dir, opts = {}) {
  const cfg = { rareDf: RARE_DF, minShared: MIN_SHARED, limit: LIMIT, ...opts };
  let db = null;
  try {
    db = openDb(dir);
    const total = db.prepare('select count(*) as n from events').get().n;
    if (!total) return { total: 0, rareEntities: 0, candidates: [] };

    // ① 挑稀有实体（df 在 [2, rareDf] 之间：df=1 的共现不出对，df 太大的没区分度）
    const ents = db.prepare(
      'select entity, count(*) as df from event_entities group by entity having df between 2 and ?'
    ).all(cfg.rareDf);
    if (!ents.length) return { total, rareEntities: 0, candidates: [] };

    // ② 每个稀有实体反查它落在哪些事件上，两两配对累计「共享了几个稀有实体」
    const shared = new Map();   // key -> { a, b, words:Set }
    const byId = new Map();     // id -> { id, day, brief }
    for (const { entity } of ents) {
      const evs = db.prepare(
        'select ee.event_id as id, ev.day, ev.brief from event_entities ee join events ev on ev.id = ee.event_id where ee.entity = ?'
      ).all(entity);
      for (const e of evs) if (!byId.has(e.id)) byId.set(e.id, e);
      for (let i = 0; i < evs.length; i += 1) {
        for (let j = i + 1; j < evs.length; j += 1) {
          const k = fp(evs[i].id, evs[j].id);
          if (!shared.has(k)) shared.set(k, { a: evs[i].id, b: evs[j].id, words: new Set() });
          shared.get(k).words.add(entity);
        }
      }
    }

    // ③ 过滤：够稀有共享数、且不是同一天
    const candidates = [];
    for (const [key, v] of shared) {
      if (v.words.size < cfg.minShared) continue;
      const A = byId.get(v.a);
      const B = byId.get(v.b);
      if (!A || !B) continue;
      if (A.day === B.day) continue;   // 同一天 = 同一件事的流水，不算意外关联
      candidates.push({
        kind: 'event',
        key,
        a: v.a,
        b: v.b,
        shared: v.words.size,
        words: [...v.words],
        titleA: A.brief,
        titleB: B.brief,
        pageA: A.day,
        pageB: B.day,
      });
    }
    candidates.sort((x, y) => y.shared - x.shared || String(x.key).localeCompare(String(y.key)));
    return { total, rareEntities: ents.length, candidates: candidates.slice(0, cfg.limit) };
  } catch (e) {
    // 事件库不可用不该拖垮每日联想：返回空，由调用方照常报条目对
    return { total: 0, rareEntities: 0, candidates: [], reason: String(e?.message || e).slice(0, 80) };
  } finally {
    try { db?.close(); } catch { /* 关不掉也不影响 */ }
  }
}
