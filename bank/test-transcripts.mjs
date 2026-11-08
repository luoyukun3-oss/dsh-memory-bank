// ============================================================================
// findTranscripts 多根合并测试（2026-09-30 建）
//
// 起因：官方桌面版（DeepSeek Harness 0.2）把会话写在 ~/.dsh/sessions，
// 而 findTranscripts 只扫 DSH_HOME 或 %APPDATA%\dsh-desktop\harness\sessions
// —— 后果是「用户跟官方版聊的内容永远进不了记忆库」。
//
// 本测试不碰真实环境：在系统临时目录造两个假 harness home，各放一个假会话文件，
// 再断言两个根里的文件都能被找到、重复根会去重、不存在的根会被忽略。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findTranscripts, transcriptHomes } from './core.mjs';

export function runTranscriptTests({ ok }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ft-'));
  const mkRoot = (name, slug, sid) => {
    const dir = path.join(tmp, name, 'sessions', slug, sid);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'session.v9.jsonl.zstd');
    fs.writeFileSync(f, Buffer.alloc(16, 7));
    return f;
  };
  const rootA = path.join(tmp, 'rootA');
  const rootB = path.join(tmp, 'rootB');
  const fA = mkRoot('rootA', '--E-2--', 'sess-A');
  const fB = mkRoot('rootB', '--E-2--', 'sess-B');
  const other = mkRoot('rootB', '--C-other--', 'sess-C');

  // 1. 两个额外根都被认到
  const homes = transcriptHomes([rootA, rootB]);
  ok(homes.includes(path.resolve(rootA)) && homes.includes(path.resolve(rootB)),
    '两个额外根都进了 home 列表', JSON.stringify(homes.map((h) => h.replace(tmp, '…'))));

  // 2. 合并后两个根里的会话都能被找到（核心断言）
  const list = findTranscripts('E:\\2', [rootA, rootB]);
  const files = list.map((x) => x.file);
  ok(files.includes(fA), 'A 根里的会话被找到');
  ok(files.includes(fB), 'B 根里的会话被找到（这就是修复点）');
  ok(list.some((x) => x.file === other), '不匹配 slug 时退回全部（原行为不变）');
  ok(list.every((x) => typeof x.dirName === 'string' && x.mtime > 0 && x.size > 0),
    '返回结构不变（file/size/mtime/dirName）');

  // 3. 排序仍是 mtime 倒序
  const sorted = list.map((x) => x.mtime);
  ok(sorted.every((v, i) => i === 0 || sorted[i - 1] >= v), '按 mtime 倒序');

  // 4. 重复根去重
  const dup = transcriptHomes([rootA, rootA]);
  ok(dup.filter((h) => h.startsWith(tmp)).length === 1, '重复根只算一次');

  // 5. 不存在的根被忽略
  const ghost = transcriptHomes([path.join(tmp, 'nope')]);
  ok(!ghost.some((h) => h.includes('nope')), '不存在的根被忽略');

  // 6. 不传第二参数时行为不变（向后兼容）
  const legacy = transcriptHomes();
  ok(Array.isArray(legacy), '不传 extra 时照样返回数组（默认的 harness home）', JSON.stringify(legacy.map((h) => h.replace(process.env.USERPROFILE || 'x', '~'))));

  fs.rmSync(tmp, { recursive: true, force: true });
}
