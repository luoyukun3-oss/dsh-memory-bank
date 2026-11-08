// 多帧 zstd 解压模块：DSH 的 session.jsonl.zstd 是逐段追加的多帧压缩文件，
// 普通的 zstdDecompressSync 只解第一帧，必须按魔数切分逐帧解压。
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把多帧 zstd 缓冲一次性解压为 Buffer */
export function decompressAll(buffer) {
  const marks = [];
  let idx = buffer.indexOf(MAGIC);
  while (idx !== -1) {
    marks.push(idx);
    idx = buffer.indexOf(MAGIC, idx + 4);
  }
  if (marks.length === 0) return zlib.zstdDecompressSync(buffer); // 不是多帧，按普通处理

  const parts = [];
  let pos = 0;
  while (pos < marks.length) {
    const end = pos + 1 < marks.length ? marks[pos + 1] : buffer.length;
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(marks[pos], end)));
      pos += 1;
      continue;
    } catch {
      // 魔数是误判（刚好出现在压缩数据里），把后续分界并进来重试
      let k = pos + 1;
      let ok = false;
      while (k < marks.length) {
        const end2 = k + 1 < marks.length ? marks[k + 1] : buffer.length;
        try {
          parts.push(zlib.zstdDecompressSync(buffer.subarray(marks[pos], end2)));
          pos = k + 1;
          ok = true;
          break;
        } catch {
          k += 1;
        }
      }
      if (!ok) break;
    }
  }
  return Buffer.concat(parts);
}

/** 读取一个 .jsonl.zstd 会话日志，返回记录数组 */
export function readSessionRecords(file) {
  const text = decompressAll(fs.readFileSync(file)).toString('utf8');
  const recs = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {}
  }
  return recs;
}

/** 会话目录下所有会话日志，按大小降序（最大的通常是当前会话） */
export function listSessionLogs(sessionsRoot) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd')) out.push({ file: p, size: fs.statSync(p).size });
    }
  };
  walk(sessionsRoot);
  return out.sort((a, b) => b.size - a.size);
}

/** 从记录里抽出人类可读的关键信息 */
export function summarize(recs) {
  const textOf = (content) =>
    (content || [])
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();

  const meta = recs.find((r) => r.type === 'session') || {};
  const titles = recs.filter((r) => r.type === 'session/title').map((r) => r.data?.title).filter(Boolean);
  const users = recs
    .filter((r) => r.type === 'user/message' && r.data?.source?.kind === 'user')
    .map((r) => ({ time: r.time, text: textOf(r.data.content) }));
  const assistants = recs
    .filter((r) => r.type === 'assistant/message')
    .map((r) => ({ turn: r.data?.turn, step: r.data?.step, text: textOf(r.data?.message?.content) }))
    .filter((a) => a.text);
  const tools = {};
  for (const r of recs.filter((r) => r.type === 'tool/call')) {
    const n = r.data?.name || '(未知)';
    tools[n] = (tools[n] || 0) + 1;
  }
  return {
    id: meta.id,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    titles,
    users,
    assistants,
    tools,
    counts: {
      records: recs.length,
      userMessages: users.length,
      assistantMessages: assistants.length,
      toolCalls: recs.filter((r) => r.type === 'tool/call').length,
      turns: recs.filter((r) => r.type === 'turn/end').length,
    },
  };
}
