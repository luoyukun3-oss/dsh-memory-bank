// 把备份的会话日志（.jsonl.zstd）解压成可读的 .jsonl
// DSH 的会话日志是多帧 zstd，必须逐帧解压（见 zstd_multi.mjs）
// 用法：node read_session.mjs <会话日志.jsonl.zstd> [输出.jsonl]
import fs from 'node:fs';
import { decompressAll } from './zstd_multi.mjs';

const input = process.argv[2];
if (!input) {
  console.error('用法：node read_session.mjs <会话日志.jsonl.zstd> [输出.jsonl]');
  process.exit(1);
}
const output = process.argv[3] || input.replace(/\.zstd$/, '');

try {
  const text = decompressAll(fs.readFileSync(input)).toString('utf8');
  fs.writeFileSync(output, text, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  console.log(`已解压：${output}`);
  console.log(`大小：${(text.length / 1024 / 1024).toFixed(2)} MB，共 ${lines.length} 行 JSONL`);
} catch (e) {
  console.error('解压失败：' + e.message);
  process.exit(2);
}
