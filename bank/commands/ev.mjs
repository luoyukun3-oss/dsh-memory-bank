// Memory Bank · `cli ev` —— 事件存储的命令行入口（2026-10-26）
//
// 子命令：
//   import          从 pages/events.md 全量重建库（幂等，可反复跑）
//   list [--day D] [--limit N]   最近事件
//   search <关键词>  事件检索
//   related <事件id> 关联（出边/入边）
//   entity <名字>    按实体反查事件 —— 「联想」的底座
//   stats           统计
//
// ⚠️ 本模块**不 import cli.mjs**（避免循环依赖）：只接 cli 传进来的 dir/opt/log。
import {
  openDb, importFromEventsMd, listEvents, searchEvents, relatedEvents, eventsByEntity, stats,
  updateEvent, addEdge, dropEdge, EVENT_EDGE_TYPES,
} from '../evstore.mjs';

export function runEvCommand({ sub = 'stats', arg, opt, log, dir }) {
  const db = openDb(dir);
  try {
    if (sub === 'import') {
      const r = importFromEventsMd(db, dir);
      log(`事件库已重建：${r.events} 条事件｜${r.entities} 个实体｜${r.rels} 条 rel 关联`);
      log(`统计：${JSON.stringify(stats(db))}`);
      return;
    }
    if (sub === 'list') {
      const day = opt('day', null);
      const limit = Number(opt('limit', day ? 50 : 20)) || 20;
      const rows = listEvents(db, { day, limit });
      if (!rows.length) { log(day ? `${day} 没有事件` : '事件库空 —— 先跑 `cli ev import`'); return; }
      for (const r of rows) {
        const flags = [r.slot, r.source, r.confidence].filter(Boolean).join('/');
        log(`${r.day}${flags ? ' [' + flags + ']' : ''} ${r.brief}`);
      }
      log(`（${rows.length} 条）`);
      return;
    }
    if (sub === 'search') {
      const kw = String(arg || opt('q', '')).trim();
      if (!kw) { log('用法：cli ev search <关键词>'); return; }
      const rows = searchEvents(db, kw);
      if (!rows.length) { log(`没搜到「${kw}」`); return; }
      for (const r of rows) log(`${r.day}  ${r.brief}`);
      log(`（${rows.length} 条）`);
      return;
    }
    if (sub === 'related') {
      const id = String(arg || '').trim();
      if (!id) { log('用法：cli ev related <事件id>（如 ev-2026-09-15-01）'); return; }
      const r = relatedEvents(db, id);
      if (!r.outgoing.length && !r.incoming.length) { log(`${id} 目前没有任何关联边`); return; }
      for (const e of r.outgoing) log(`→ ${e.to_id}${e.type ? ' (' + e.type + ')' : ''}${e.note ? '：' + e.note : ''}`);
      for (const e of r.incoming) log(`← ${e.from_id}${e.type ? ' (' + e.type + ')' : ''}${e.note ? '：' + e.note : ''}`);
      return;
    }
    if (sub === 'entity') {
      const name = String(arg || opt('q', '')).trim();
      if (!name) { log('用法：cli ev entity <名字>`（先 `cli ev stats` 看看有没有实体）'); return; }
      const rows = eventsByEntity(db, name);
      if (!rows.length) { log(`实体「${name}」没有关联事件`); return; }
      for (const r of rows) log(`${r.day}  ${r.brief}`);
      log(`（${rows.length} 条）`);
      return;
    }
    // —— note（2026-10-27）：**概要由我写**。autolog 记的只是「用户说了什么 + 用了哪些工具」，
    //    真正的事件摘要得由会思考的一方补；detail 存「完整事件」（像上下文一样，不截断）。
    if (sub === 'note') {
      const id = String(arg || '').trim();
      if (!id) { log('用法：cli ev note <事件id> [--brief "摘要"] [--detail "完整描述"] [--kind diag|feat|bug|talk] [--importance 1-5]'); return; }
      const patch = {};
      for (const k of ['brief', 'detail', 'kind', 'source', 'confidence']) {
        const v = opt(k, null);
        if (v !== null) patch[k] = String(v);
      }
      if (opt('importance', null) !== null) patch.importance = Number(opt('importance'));
      const r = updateEvent(db, id, patch);
      if (!r.ok) { log(`没改成：${r.reason || '事件 id 不存在？先 cli ev list --day <日期> 查一下'}`); return; }
      // 回读确认（别只看 changes 数字）
      const row = db.prepare('select id, brief, detail, kind from events where id = ?').get(id);
      log(`已更新 ${row.id}｜brief=${String(row.brief).slice(0, 40)}…｜detail ${row.detail ? String(row.detail).length + ' 字' : '仍为空'}｜kind=${row.kind || '-'}`);
      return;
    }
    // —— link / drop（2026-10-27）：每日联想报出「事件×事件」后，人审通过就落库成边。
    if (sub === 'link' || sub === 'drop') {
      const from = String(arg || '').trim();
      const to = String(opt('to', '') || '').trim();   // ⚠️ cli 只传 positional[1] 给 arg，第二个 id 必须走 --to
      if (!from || !to) { log(`用法：cli ev ${sub} <from> --to <to> [--type ${EVENT_EDGE_TYPES.join('|')}] [--note "说明"]`); return; }
      if (sub === 'drop') {
        const r = dropEdge(db, from, to);
        log(r.removed ? `已删除边 ${from} → ${to}` : `没有这条边（${from} → ${to}）`);
        return;
      }
      const r = addEdge(db, from, to, { type: String(opt('type', 'relates')), note: String(opt('note', '')) });
      if (!r.ok) { log(`没建成：${r.reason}`); return; }
      log(r.inserted ? `已建边 ${from} → ${to}（${opt('type', 'relates')}）` : `这条边已经存在：${from} → ${to}`);
      return;
    }
    // 默认 stats
    const s = stats(db);
    log(`事件库：${s.events} 条｜${s.days} 天｜${s.entities} 个实体｜${s.edges} 条边｜导入于 ${s.importedAt || '(未导入)'}`);
    log('用法：cli ev import | list [--day D] [--limit N] | search <kw> | related <id> | entity <name> | note <id> --brief/--detail | link <from> --to <to> --type X | drop <from> --to <to> | stats');
    return;
  } finally {
    try { db.close(); } catch {}
  }
}
