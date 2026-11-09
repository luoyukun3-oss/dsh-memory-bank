// ============================================================================
// test-index-rebuild.mjs —— 第 37 节：索引批量重建的「失败率门 + 不切换」（2026-11-08）
//
// 守的是 LivingMemory `index_validator_rebuild.py` 那套机制的**核心承诺**：
//   ① 失败率 > 上限 ⇒ **线上一个字节都不动**（它靠 shadow 表 + `if not switched: DROP`）
//   ② 失败率可接受 ⇒ 提交，但**成功的那部分也要标 partial 并留失败名单**
//   ③ 失败名单不能只返回给调用方就丢（落 `state/index-rebuild.json`，`cli status` 看得见）
//
// ⚠️ 全部用临时目录造数据 —— **绝不对真实库跑批量重建**（那会重写 5.7 MB 的 index.json）。
// ⚠️ 「字节未变」用 **sha256** 比对，不用"看起来一样"：`stampIndex` 会往文件里写 stats/updatedAt，
//    任何一次误提交都会改变字节 —— 哈希是唯一不会骗人的判据。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildPageDocs, listPageFiles, MAX_FAILURE_RATIO, readRebuildState, rebuildIndex } from './index-rebuild.mjs';
import { reindexPage } from './index.mjs';
import { indexStatusLine } from './index-schema.mjs';

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const pageBody = (tag) => `# ${tag}\n\n## 小节一\n\n- 条目一（${tag}）\n- 条目二（${tag}）\n`;
const pageSet = (names) => Object.fromEntries(names.map((n) => [n, pageBody(n.replace('.md', ''))]));

/** 造一个临时库：pages/ 下有这些页，index.json 预置 `docs`（默认空）。 */
function tmpBank(pages = {}, { docs = [] } = {}) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rebuild-'));
  fs.mkdirSync(path.join(T, 'pages'), { recursive: true });
  for (const [name, body] of Object.entries(pages)) fs.writeFileSync(path.join(T, 'pages', name), body, 'utf8');
  fs.writeFileSync(path.join(T, 'index.json'), JSON.stringify({ docs, updatedAt: 'old' }), 'utf8');
  return T;
}
const idxFile = (T) => path.join(T, 'index.json');
const readIdx = (T) => JSON.parse(fs.readFileSync(idxFile(T), 'utf8'));
const pagesInIdx = (T) => [...new Set((readIdx(T).docs || []).map((d) => d.page))].sort();
const seedDoc = (page) => ({ id: `${page}#0`, page, title: '旧条目', text: '旧内容', tokens: ['旧'], updated: 'x' });

export function runIndexRebuildTests({ ok }) {
  console.log('== 37. 索引批量重建：失败率门 + 不切换（2026-11-08，抄自 index_validator_rebuild） ==');
  ok(MAX_FAILURE_RATIO === 0.2, `失败率上限默认 0.2（实得 ${MAX_FAILURE_RATIO}）—— 与参考实现同参数`);

  // ① 全部成功 ⇒ 提交、switched=true、无失败
  {
    const T = tmpBank(pageSet(['a.md', 'b.md', 'c.md']));
    const r = rebuildIndex(T);
    ok(r.ok === true && r.switched === true, `全部成功 ⇒ ok/switched 都为 true（ok=${r.ok} switched=${r.switched}）`);
    ok(r.partial === false && r.failed.length === 0, '全部成功 ⇒ partial=false、失败名单为空');
    ok(r.processed === 3 && r.skipped === 0, `3 页全部处理（processed=${r.processed} skipped=${r.skipped}）`);
    ok(pagesInIdx(T).join(',') === 'a.md,b.md,c.md', `索引里三页都在（实得 ${pagesInIdx(T).join(',')}）`);
    ok(r.docsAfter === readIdx(T).docs.length && r.docsAfter > 0, `返回条数与回读一致（${r.docsAfter} 条）`);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ② 失败率超阈值 ⇒ **不提交**、线上文件**字节级未变**（本节是整个任务的核心断言）
  {
    const T = tmpBank(pageSet(['a.md', 'b.md']), { docs: [seedDoc('a.md')] });
    fs.writeFileSync(path.join(T, 'pages', 'empty.md'), '', 'utf8');          // 空页 ⇒ 失败
    const before = sha(idxFile(T));
    const r = rebuildIndex(T, ['a.md', 'b.md', 'ghost1.md', 'ghost2.md', 'empty.md']);
    const after = sha(idxFile(T));
    ok(r.ok === false && r.switched === false, `失败率过高 ⇒ ok/switched 都是 false（ok=${r.ok}）`);
    ok(r.failureRatio > MAX_FAILURE_RATIO, `失败率 ${(r.failureRatio * 100).toFixed(0)}% 超过上限 ${MAX_FAILURE_RATIO * 100}%`);
    ok(r.stoppedEarly === true, '一超标就中途停手（没再继续跑后面的页）');
    ok(before === after, `⚠️ 线上 index.json 字节未变（sha256 ${before.slice(0, 12)}… 前后一致）`);
    ok(readIdx(T).docs.length === 1, '索引条数仍是原来的 1 条（既没清空也没改写）');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ③ 部分失败但未超阈值 ⇒ 提交 + partial=true + 失败名单非空；**失败页保留旧条目**
  {
    const T = tmpBank(pageSet(['a.md', 'b.md', 'c.md', 'd.md']), { docs: [seedDoc('old.md')] });
    fs.writeFileSync(path.join(T, 'pages', 'old.md'), '', 'utf8');            // 内容被清空 ⇒ 失败
    const r = rebuildIndex(T, ['a.md', 'b.md', 'c.md', 'd.md', 'old.md']);    // 1/5 = 20%，正好等于上限 ⇒ 放行
    ok(r.ok === true && r.switched === true, `失败率 20% 未超阈值 ⇒ 提交（ratio=${r.failureRatio}）`);
    ok(r.partial === true, '仍有失败页 ⇒ partial=true（成功的那部分也要如实标注）');
    ok(r.failedIds.length === 1 && r.failedIds[0] === 'old.md', `失败名单 = ${JSON.stringify(r.failedIds)}`);
    ok(readIdx(T).docs.some((d) => d.page === 'old.md'), '失败页的旧条目被保留 —— 重建失败不等于把整页删掉');
    ok(pagesInIdx(T).includes('a.md') && pagesInIdx(T).includes('d.md'), '成功页都进了索引');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ④ 空页列表 / 空库 ⇒ 不炸、不动线上文件（`[]` 是 no-op，不是"清空索引"）
  {
    const T = tmpBank(pageSet(['a.md']), { docs: [seedDoc('a.md')] });
    const before = sha(idxFile(T));
    const r = rebuildIndex(T, []);
    ok(r.ok === true && r.switched === false, `空页列表 ⇒ 不炸、不提交（reason=${r.reason}）`);
    ok(sha(idxFile(T)) === before, '空页列表 ⇒ 索引字节未变（没被当成"清空"');
    fs.rmSync(T, { recursive: true, force: true });

    const T2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rebuild-'));          // 连 pages/ 都没有
    const r2 = rebuildIndex(T2);
    ok(r2.ok === true && r2.switched === false && r2.total === 0, `空库 ⇒ 不炸、不提交（total=${r2.total}）`);
    fs.rmSync(T2, { recursive: true, force: true });
  }

  // ⑤ 归档页 / 有意不入池的页：**跳过 ≠ 失败**（否则正常库会报 20% 失败）
  {
    const T = tmpBank({ 'a.md': pageBody('a'), 'archive.md': pageBody('arch'), 'handoff.md': pageBody('hand') });
    const r = rebuildIndex(T);
    ok(r.ok === true && r.skipped === 2 && r.failed.length === 0, `archive/handoff 记 skipped 不算失败（skipped=${r.skipped} failed=${r.failed.length}）`);
    ok(r.failureRatio === 0, '失败率 0 —— 分母已排除"有意跳过"的页');
    ok(!pagesInIdx(T).some((p) => p === 'archive.md' || p === 'handoff.md'), '有意不入池的页没进索引');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑥ 失败名单要留得下来：state 文件 + `cli status` 那一行（cli.mjs 不在本组写作用域，
  //    所以接在 indexStatusLine 上 —— 它正是 `cli status` 打印的那行）
  {
    const T = tmpBank(pageSet(['a.md', 'b.md', 'c.md', 'd.md']));
    fs.writeFileSync(path.join(T, 'pages', 'old.md'), '', 'utf8');
    rebuildIndex(T, ['a.md', 'b.md', 'c.md', 'd.md', 'old.md']);
    const st = readRebuildState(T, 5);
    ok(st.length === 1 && (st[0].failedIds || []).join() === 'old.md', `state/index-rebuild.json 留了失败名单（${JSON.stringify(st[0] && st[0].failedIds)}）`);
    const line = indexStatusLine(T);
    ok(line.includes('上次重建') && line.includes('⚠️'), `status 行看得见失败页（${line}）`);
    const T2 = tmpBank(pageSet(['a.md', 'b.md']));
    rebuildIndex(T2);
    const line2 = indexStatusLine(T2);
    ok(line2.includes('上次重建 ✅') && !line2.includes('⚠️'), `全成功时 status 行是 ✅（${line2}）`);
    fs.rmSync(T, { recursive: true, force: true });
    fs.rmSync(T2, { recursive: true, force: true });
  }

  // ⑦ 单页 `reindexPage` 仍按原契约工作（返回该页条目数；不存在的页返回 0 且不抛）
  {
    const T = tmpBank(pageSet(['a.md', 'b.md']));
    const n1 = reindexPage(T, 'a.md');
    const aDocs = readIdx(T).docs.filter((d) => d.page === 'a.md').length;
    ok(n1 === aDocs && n1 > 0, `reindexPage 返回该页条目数（${n1} vs 索引里 ${aDocs} 条）`);
    ok(readIdx(T).docs.filter((d) => d.page === 'b.md').length === 0, '只重建这一页：别的页没被顺手建进来');
    ok(reindexPage(T, 'nothere.md') === 0, '不存在的页 ⇒ 返回 0（不抛）');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑧ dryRun：算得出来，但一个字节都不落
  {
    const T = tmpBank(pageSet(['a.md']), { docs: [seedDoc('a.md')] });
    const before = sha(idxFile(T));
    const r = rebuildIndex(T, ['a.md'], { dryRun: true });
    ok(r.ok === true && r.switched === false, `dryRun ⇒ 算出来了但 switched=false（processed=${r.processed}）`);
    ok(sha(idxFile(T)) === before, 'dryRun ⇒ 索引字节未变');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑨ buildPageDocs 的失败原因要分得清（排查时"读不到"和"空页"完全是两件事）
  {
    const T = tmpBank({ 'a.md': pageBody('a') });
    const miss = buildPageDocs(T, 'ghost.md');
    ok(miss.ok === false && /文件不存在/.test(miss.reason || ''), `缺文件 ⇒ reason 说清是文件不存在（${miss.reason}）`);
    fs.writeFileSync(path.join(T, 'pages', 'empty2.md'), '   \n', 'utf8');
    const empty = buildPageDocs(T, 'empty2.md');
    ok(empty.ok === false && /空的|0 条目/.test(empty.reason || ''), `空页 ⇒ reason 说清是 0 条目（${empty.reason}）`);
    ok(listPageFiles(T).join(',') === 'a.md,empty2.md', `listPageFiles 只认 .md（实得 ${listPageFiles(T).join(',')}）`);
    fs.rmSync(T, { recursive: true, force: true });
  }
}
