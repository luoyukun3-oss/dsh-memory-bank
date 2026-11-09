// ============================================================================
// test-ev-stamp.mjs —— 第 44 节：ev 的指纹跳过必须**独立**于 ingest 的 stamps
//
// 守的是 2026-11-09 的一个真 bug（不是假想）：
//   我给 ev 加「文件没变就跳过解压」的优化时，第一版**复用了 ingest 的 `state.stamps`**。
//   结果：ingest 在 tick 里跑在 ev 前面，会抢先更新那个键 ⇒ ev 第一次就被误判「已抽过」、
//   事件永远不落库。实测：连跑两次 quick tick，第一次 ev 就「·跳过」。
//
//   修法：ev 用**独立的** `state/ev-stamp.json`（键=会话目录名、值=`size:mtimeMs`），
//   且指纹只在**成功抽取之后**写（失败不写 ⇒ 下次照常重试）。
//
// 所以这里三条断言各守一条：
//   ① 没抽过（ev-stamp.json 无此键）⇒ skip=false（不误跳）
//   ② 抽过且文件没变（指纹相同）⇒ skip=true
//   ③ ev-stamp.json 与 state.json 的 stamps 是**两个文件**（防止有人改回共用）
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evShouldSkip } from './ev-autolog.mjs';

export function runEvStampTests({ ok }) {
  console.log('== 44. ev 指纹跳过独立于 ingest stamps（2026-11-09，共用会丢事件） ==');

  // 造一个临时 dir + 假会话日志文件
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-evstamp-'));
  const dir = path.join(T, 'repo');
  const sessDir = path.join(T, 'sessions', '--E-2--', 'session-evt');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(sessDir, { recursive: true });
  const file = path.join(sessDir, 'session.v3.jsonl.zstd');
  fs.writeFileSync(file, 'FAKE-ZSTD-CONTENT', 'utf8');

  // ① 没抽过 ⇒ 不跳过
  {
    const r = evShouldSkip(dir, file);
    ok(r.skip === false, 'ev-stamp.json 没有这个键 ⇒ 不跳过（第一次要真抽）');
    ok(r.fp && r.fp.includes(':') && r.fp.includes('.'), `指纹格式 size:mtimeMs（${r.fp}）`);
  }

  // ② 抽过 + 文件没变 ⇒ 跳过
  {
    const fp = evShouldSkip(dir, file).fp;
    fs.writeFileSync(path.join(dir, 'state', 'ev-stamp.json'), JSON.stringify({ [evShouldSkip(dir, file).key]: fp }), 'utf8');
    const r = evShouldSkip(dir, file);
    ok(r.skip === true, '指纹相同 ⇒ 跳过（省掉解压）');
  }

  // ③ ev-stamp.json 与 state.json 的 stamps 是两个文件（防改回共用）
  {
    // 模拟「ingest 已经写了 state.json 的 stamps」—— ev 不能因为它而跳过
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ stamps: { 'session-evt': 'whatever' } }), 'utf8');
    fs.rmSync(path.join(dir, 'state', 'ev-stamp.json'));   // 清掉 ev 自己的，只留 ingest 的
    const r = evShouldSkip(dir, file);
    ok(r.skip === false, '只有 ingest 的 state.stamps、没有 ev-stamp.json ⇒ 仍不跳过（两者独立）');
    ok(fs.existsSync(path.join(dir, 'state.json')) && !fs.existsSync(path.join(dir, 'state', 'ev-stamp.json')),
      '两个文件互不覆盖');
  }

  // ④ 文件变了（内容改写 ⇒ mtime 变）⇒ 不跳过
  {
    const fp = evShouldSkip(dir, file).fp;
    fs.writeFileSync(path.join(dir, 'state', 'ev-stamp.json'), JSON.stringify({ [evShouldSkip(dir, file).key]: fp }), 'utf8');
    fs.writeFileSync(file, 'FAKE-ZSTD-CONTENT-CHANGED', 'utf8');   // 内容变
    fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));  // 保证 mtime 也变
    const r = evShouldSkip(dir, file);
    ok(r.skip === false, '文件变了 ⇒ 不跳过（重新抽取新事件）');
  }

  fs.rmSync(T, { recursive: true, force: true });
}
