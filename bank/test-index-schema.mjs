// ============================================================================
// test-index-schema.mjs —— 第 36 节：索引的结构版本与自描述（2026-11-08）
//
// 守的是两件「判不出来」的事（今天两起事故的共同根）：
//   ① **读到的是哪一版** —— 结构演进后，老代码会把新索引当自己的用。
//   ② **这份索引是不是完整的** —— docs 从 2288 悄悄掉到 1056 时，文件本身长得完全正常，
//      没有任何自描述字段能跟"它应该有这么多条"对照。
//
// 抄自 `storage/db_migration.py` 的两条纪律：
//   · **判不准就倒向最旧**（版本号缺失/认不出 ⇒ 当旧版处理，不猜成新版）
//   · **转不动就只打标记**（`verifyIndex` 只报不修 —— 索引能从 pages/*.md 完全重建，不需要迁移）
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INDEX_SCHEMA_VERSION, stampIndex, verifyIndex, indexStatusLine } from './index-schema.mjs';

const mkDocs = (page, n) => Array.from({ length: n }, (_, i) => ({
  id: `${page}#${i}`, page, kind: 'page', title: `t${i}`, text: `x${i}`, tokens: ['x'], updated: 'now',
}));

/** 造临时库并写入给定索引对象（原样写，不打标 —— 用来模拟各种坏状态）。 */
function bank(idx, { tag = false } = {}) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-schema-'));
  const obj = tag ? stampIndex(idx) : idx;
  fs.writeFileSync(path.join(T, 'index.json'), JSON.stringify(obj), 'utf8');
  return T;
}

export function runIndexSchemaTests({ ok }) {
  console.log('== 36. 索引的结构版本与自描述（2026-11-08，治「读不出是哪一版」） ==');

  // ① 打标正确
  {
    const idx = { docs: [...mkDocs('a.md', 3), ...mkDocs('b.md', 2)], updatedAt: 'x' };
    const s = stampIndex(idx);
    ok(s.schemaVersion === INDEX_SCHEMA_VERSION, `stampIndex 写上 version=${INDEX_SCHEMA_VERSION}`);
    ok(s.stats.docs === 5, `stats.docs=5（实得 ${s.stats.docs}）`);
    ok(s.stats.pages === 2, `stats.pages=2（实得 ${s.stats.pages}）`);
    ok(s.stats.byPage['a.md'] === 3 && s.stats.byPage['b.md'] === 2, 'byPage 逐页条数正确');
    ok(s.docs === idx.docs, '原有 docs 原样保留（不复制、不改内容）');
  }

  // ② 正常库 ⇒ ok
  {
    const T = bank({ docs: mkDocs('a.md', 10) }, { tag: true });
    const r = verifyIndex(T);
    ok(r.ok && r.version === INDEX_SCHEMA_VERSION, `打标后的库 verify 通过（v${r.version}、${r.docs} 条）`);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ③ 没有版本号 ⇒ **倒向旧版**（不猜成新版），并给重建指引
  {
    const T = bank({ docs: mkDocs('a.md', 5) });    // 不打标 = 2026-11-08 之前的索引
    const r = verifyIndex(T);
    ok(!r.ok && r.version === null, '无版本号 ⇒ 判为"旧索引"（version=null，不猜成 v1）');
    ok(r.problems.some((p) => p.includes('cli init')), '问题里给了重建指引（cli init）');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ④ 版本比代码新 ⇒ 警告「别用老代码覆盖」（这条最重要：防降级写坏）
  {
    const T = bank({ docs: mkDocs('a.md', 5), schemaVersion: INDEX_SCHEMA_VERSION + 1 });
    const r = verifyIndex(T);
    ok(!r.ok, '版本更新 ⇒ 不 ok');
    ok(r.problems.some((p) => p.includes('别用老代码覆盖')), '明确警告「别用老代码覆盖它」');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑤ stats 与实际不符 ⇒ 抓「文件被外部改过 / 写了一半」
  {
    const idx = stampIndex({ docs: mkDocs('a.md', 10) });
    idx.docs = idx.docs.slice(0, 4);              // 偷偷砍掉 6 条，stats 仍写 10
    const T = bank(idx);
    const r = verifyIndex(T);
    ok(!r.ok, 'stats 与实际不符 ⇒ 不 ok');
    ok(r.problems.some((p) => p.includes('stats.docs=10') && p.includes('实际 4')), `报出具体数字（${r.problems.find((p) => p.includes('stats.docs')) || '无'}）`);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑥ 某页条目变少 ⇒ 单独报出是哪一页（比只报总数更容易定位）
  {
    const idx = stampIndex({ docs: mkDocs('big.md', 20) });
    idx.docs = mkDocs('big.md', 6);               // big.md 20 → 6
    const T = bank(idx);
    const r = verifyIndex(T);
    ok(r.problems.some((p) => p.includes('big.md') && p.includes('20→6')), `报出页级缩水（${r.problems.find((p) => p.includes('big.md')) || '无'}）`);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑦ 缺 tokens ⇒ 结构性损坏
  {
    const T = bank({ docs: [{ id: 'a#1', page: 'a.md', title: 't', text: 'x' }], schemaVersion: INDEX_SCHEMA_VERSION });
    const r = verifyIndex(T);
    ok(r.problems.some((p) => p.includes('tokens')), '缺 tokens ⇒ 报结构不对');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑧ 文件坏 / 不存在 ⇒ 不抛、给出可读结论
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-schema-'));
    ok(verifyIndex(T).ok === false, 'index.json 不存在 ⇒ ok=false（不抛）');
    fs.writeFileSync(path.join(T, 'index.json'), '{坏掉的JSON', 'utf8');
    ok(verifyIndex(T).ok === false, 'index.json 是坏 JSON ⇒ ok=false（不抛）');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑨ status 行：健康时不带警告符号
  {
    const T = bank({ docs: mkDocs('a.md', 10) }, { tag: true });
    const line = indexStatusLine(T);
    ok(line.includes('stats 自洽') && !line.includes('⚠️'), `status 行健康（${line}）`);
    fs.rmSync(T, { recursive: true, force: true });
  }
}
