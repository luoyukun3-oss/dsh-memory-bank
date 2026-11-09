// ============================================================================
// test-ingest-cursor.mjs —— 第 30 节：摄入游标的两个退化（2026-11-08）
//
// 守的是什么（两条都是**实测出来的**，不是想出来的）：
//   ① **偏移越界重读必须幂等**。原实现 `if (start > recs.length) start = 0;` 回退全量，
//      但写流水是「读旧文件 + 追加新段」⇒ 一次越界就把该会话全部历史**再灌一遍**。
//      实测 journal 里 716 段完全重复、占 24.3%（466 KB / 1.87 MB），最狠一页 86% 是重灌的。
//   ② **空切片不能反复追加空段**。原实现 `if (!slice.length) continue;` 在 `continue` **之前**
//      没写偏移 ⇒ tick 每 30 分钟跑一次就往 journal 追加一个只有标题的空段
//      （实测今天一个会话 99 段里 23 段是空的）。
//
// ⚠️ 用**临时目录**造数据，不碰真库：这条逻辑的正确性与真实内容无关，只与「段数」有关。
// ⚠️ 会话日志是 zstd 多帧格式 —— 这里用 `zlib.zstdCompressSync` 造一个单帧文件，
//    `readRecords` → `decompressAll` 对单帧走的就是「找不到 MAGIC 就整体解压」那条分支。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ingest } from './ingest.mjs';

/** 在临时目录里搭一个最小银行（只放 ingest 会碰的文件）。 */
function makeBank() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cursor-'));
  const repo = path.join(tmp, 'repo');
  for (const d of ['journal', 'pages']) fs.mkdirSync(path.join(repo, d), { recursive: true });
  const w = (f, o) => fs.writeFileSync(path.join(repo, f), typeof o === 'string' ? o : JSON.stringify(o));
  w('bank.json', { cwd: 'E:\\2', sessions: {} });
  w('state.json', { offsets: {} });
  w('access.json', {});
  w('cooccur.json', {});
  w('discarded.json', { items: [] });
  w('index.json', { docs: [] });
  w(path.join('pages', 'inbox.md'), '# inbox\n');
  return { tmp, repo };
}

/** 造一个会话日志：n 条 user/message（zstd 单帧）。 */
function makeTranscript(tmp, n) {
  const dir = path.join(tmp, 'sessions', '--E-2--', 'session-cursor-test');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [{ type: 'session', time: Date.now() }];
  for (let i = 0; i < n; i++) {
    rows.push({
      type: 'user/message', time: Date.now() + i,
      data: { role: 'user', content: [{ type: 'text', text: `第${i}条游标测试消息内容` }], source: { kind: 'user' } },
    });
  }
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')));
  return file;
}

const readJournal = (repo) => {
  const jd = path.join(repo, 'journal');
  const out = {};
  for (const f of fs.readdirSync(jd)) if (f.endsWith('.md')) out[f] = fs.readFileSync(path.join(jd, f), 'utf8');
  return out;
};
const segCount = (txt) => (txt.match(/^## 会话 /gm) || []).length;

export function runIngestCursorTests({ ok }) {
  console.log('== 30. 摄入游标：越界重读要幂等、空切片不许反复追加空段（2026-11-08） ==');
  // ① 正常增量：跑两次，第二次没有新记录 ⇒ 段数不增（空切片不追加）
  {
    const { tmp, repo } = makeBank();
    const file = makeTranscript(tmp, 3);
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    const after1 = segCount(Object.values(readJournal(repo)).join(''));
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    const after2 = segCount(Object.values(readJournal(repo)).join(''));
    ok(after1 === 1, `首次摄入写 1 段（实得 ${after1}）`);
    ok(after2 === 1, `第二次无新记录 ⇒ 段数不增（实得 ${after2}）—— 空切片不许反复追加空段`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ② 偏移越界（真实形态：文件被截断/轮转 ⇒ size/mtime 变 ⇒ 指纹变才会触发重读）
  //   ⚠️ 2026-11-09 改：旧版测试是「人为把 offset 设 9999、文件不动」—— 加了指纹优化后
  //   那种"文件没变却越界"的场景**现实里不可能发生**（越界必伴随文件被截断=指纹变），
  //   所以旧测法会假红（指纹相同 ⇒ 直接跳过 ⇒ 不触发越界检测）。改成真实形态：覆盖成更短的文件。
  {
    const { tmp, repo } = makeBank();
    const file = makeTranscript(tmp, 3);
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    makeTranscript(tmp, 2);                       // 覆盖成 2 条（更短 ⇒ 指纹必变）
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    const txt = Object.values(readJournal(repo)).join('');
    ok(/偏移越界，已重读/.test(txt), '流水里标出了「偏移越界，已重读」，便于事后追查');
    const segs = txt.split(/(?=\n## 会话 )/).slice(1);
    const bodies = segs.map((s) => s.replace(/^\n## 会话 [^\n]*\n/, '').trim());
    const dup = bodies.length - new Set(bodies).size;
    ok(dup === 0, `越界重读后没有重复段（重复 ${dup} 段）—— 重读必须幂等`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ③ 越界后偏移回到真实记录数（不能停在旧值，否则下次又重读）
  {
    const { tmp, repo } = makeBank();
    const file = makeTranscript(tmp, 3);
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    makeTranscript(tmp, 2);                        // 覆盖成 2 条：offset 4 > recs.length 3 ⇒ 越界
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    const st2 = JSON.parse(fs.readFileSync(path.join(repo, 'state.json'), 'utf8'));
    const key = Object.keys(st2.offsets)[0];
    ok(st2.offsets[key] === 3, `越界重读后偏移回到真实记录数 3（实得 ${st2.offsets[key]}）`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ④ 指纹跳过：文件没变 ⇒ 不解压、指纹不变、段数不增（本次 2026-11-09 加的核心）
  {
    const { tmp, repo } = makeBank();
    const file = makeTranscript(tmp, 3);
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    const st1 = JSON.parse(fs.readFileSync(path.join(repo, 'state.json'), 'utf8'));
    const key = Object.keys(st1.offsets)[0];
    const stamp1 = st1.stamps && st1.stamps[key];
    ok(typeof stamp1 === 'string' && stamp1.includes(':') && stamp1.includes('.'),
      `首次摄入后 state.stamps 有指纹（${stamp1}）—— 格式 size:mtimeMs`);
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    const st2 = JSON.parse(fs.readFileSync(path.join(repo, 'state.json'), 'utf8'));
    ok(st2.stamps[key] === stamp1, '文件没变 ⇒ 指纹不变（这次直接跳过解压）');
    ok(segCount(Object.values(readJournal(repo)).join('')) === 1, '第二次段数仍 1（没被重复处理）');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ⑤ 文件变了（追加记录）⇒ 指纹变 ⇒ 重新处理新增
  {
    const { tmp, repo } = makeBank();
    const file = makeTranscript(tmp, 3);
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    makeTranscript(tmp, 5);                        // 覆盖成 5 条（更长 ⇒ 指纹变 ⇒ 正常增量）
    ingest(repo, { transcript: file, cwd: 'E:\\2' });
    const segs = segCount(Object.values(readJournal(repo)).join(''));
    ok(segs >= 2, `文件变长后重新处理了新增（段数 ${segs} ≥ 2）`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
