// 一次性：把坏会话导出成①原始 JSONL（保底）②可读 Markdown。
// 用完即删。用法: node _v4export.mjs <session.v4.jsonl.zstd> <输出目录前缀>
import fs from 'node:fs';
import path from 'node:path';
import { decompressAll } from './_dsh_memory/zstd_multi.mjs';

const [src, outDir] = process.argv.slice(2);
const text = decompressAll(fs.readFileSync(src)).toString('utf8');
const rows = text.split('\n').filter((l) => l.trim()).map((l, i) => { try { return Object.assign({ _i: i + 1 }, JSON.parse(l)); } catch { return { _i: i + 1, _bad: true }; } });

fs.mkdirSync(outDir, { recursive: true });
const stamp = '20261009-1955';
const rawPath = path.join(outDir, `session-3cfb17ab-原始-${stamp}.jsonl`);
fs.writeFileSync(rawPath, text, 'utf8');

// ---- 结构探测 ----
console.log('=== 每种事件类型的结构（首个样本） ===');
const seen = new Map();
for (const r of rows) if (!seen.has(r.type)) seen.set(r.type, r);
for (const [t, r] of seen) {
  const d = r.data || {};
  const m = d.message;
  console.log(`[${t}] data={${Object.keys(d).join(',')}}` + (m ? ` message={${Object.keys(m).join(',')}}` : '') + (d.call ? ` call={${Object.keys(d.call).join(',')}}` : ''));
}

// ---- 文本提取 ----
const L = (s) => (typeof s === 'string' ? s : '');
const blocks = (m) => (Array.isArray(m?.content) ? m.content : []);
const textOf = (m) => blocks(m).filter((b) => b.type === 'text').map((b) => L(b.text)).join('\n');
const reasonOf = (m) => blocks(m).filter((b) => b.type === 'reasoning').map((b) => L(b.text ?? b.reasoning)).join('\n');
const roleOf = (m) => m?.role ?? '?';
const kindOf = (m) => m?.source?.kind ?? '(none)';
const local = (ms) => (typeof ms === 'number' ? new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '?');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…[截断，共 ${s.length} 字]` : s);

const out = [];
out.push(`# 会话 session-3cfb17ab 导出（工作区 E:\\2）`);
out.push('');
out.push(`- 导出时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
out.push(`- 来源：\`session.v4.jsonl.zstd\`（${(fs.statSync(src).size / 1024).toFixed(0)} KB 压缩）→ 解压 ${(text.length / 1024).toFixed(0)} KB / ${rows.length} 行事件`);
out.push(`- 原始 JSONL 保底：\`${path.basename(rawPath)}\``);
out.push('');
out.push(`> ⚠️ **本记录止于磁盘上最后一条成功写入的事件（seq=699，本地 19:45:38）**。`);
out.push(`> 此后该会话的持久化被 v4 准入校验拒绝（\`format v4 message requires a producer-owned source kind\`），`);
out.push(`> 19:45:38 之后的对话只存在于内存中，未落盘，无法导出。`);
out.push('');

// ---- 对话正文 ----
out.push('## 一、对话正文');
out.push('');
let nUser = 0, nAsst = 0, nInject = 0;
const injections = [];
for (const r of rows) {
  const d = r.data || {};
  if (r.type === 'user/message') {
    const k = kindOf(d);
    const t = textOf(d) || L(d.text);
    if (k !== 'user') {                                 // 注入内容（hooks / 系统提示 / skill 目录 / 模型选择）单列，不算真人输入
      if (t.trim() && k !== 'runtime-context') { nInject++; injections.push(`- \`${local(r.time)}\` **${k}** · ${t.length} 字：${clip(t.replace(/\s+/g, ' '), 200)}`); }
      continue;
    }
    if (!t.trim()) continue;
    nUser++;
    out.push(`### 👤 用户 · ${local(r.time)}  <sub>seq=${r.seq} kind=${k}</sub>`);
    out.push('');
    out.push(clip(t, 4000));
    out.push('');
  } else if (r.type === 'assistant/message') {
    const m = d.message;
    const t = textOf(m);
    const rz = reasonOf(m);
    nAsst++;
    out.push(`### 🤖 助手 · ${local(r.time)}  <sub>seq=${r.seq} 正文 ${t.length} 字 / 思考 ${rz.length} 字</sub>`);
    out.push('');
    if (t.trim()) out.push(clip(t, 6000));
    else out.push(`*（本条无正文 —— 空回复）*`);
    out.push('');
  }
}
out.push(`> 共 ${nUser} 条真人输入、${nAsst} 条助手消息；另有 ${nInject} 条系统注入（见下节，非主人发言）。`);
out.push('');

// ---- 注入内容 ----
out.push('## 一·补、系统注入内容（非真人输入，只列摘要）');
out.push('');
out.push(...(injections.length ? injections : ['*（无）*']));
out.push('');

// ---- 工具调用 ----
out.push('## 二、工具调用');
out.push('');
for (const r of rows) {
  const d = r.data || {};
  if (r.type === 'tool/call') {
    const c = d.call || d;
    const name = c.name ?? c.tool ?? d.name ?? '?';
    const args = JSON.stringify(c.arguments ?? c.args ?? d.arguments ?? '');
    out.push(`- \`${local(r.time)}\` **${name}** ${clip(args, 300).replace(/\n/g, ' ')}`);
  }
}
out.push('');

// ---- 系统事件 ----
out.push('## 三、系统事件（hooks / 重试 / 错误 / 压缩）');
out.push('');
for (const r of rows) {
  const d = r.data || {};
  let line = null;
  if (r.type === 'hook/result') line = `hook ${d.point} → ${d.decision}${d.stderrSummary ? ` | ${clip(String(d.stderrSummary), 120).replace(/\n/g, ' ')}` : ''}`;
  else if (r.type === 'llm/retry') line = `LLM 重试：provider=${d.provider} turn=${d.turn} step=${d.step} policyKey=${clip(JSON.stringify(d.policyKey), 160)}`;
  else if (r.type === 'llm/retry-started') line = `重试开始 retry=${d.retry}`;
  else if (r.type === 'compaction/prune') line = `压缩剪枝 ${JSON.stringify(d.shadowedRange)} 省 ${d.shadowedTokenCount} tokens`;
  else if (r.type === 'assistant/attempt') line = `模型尝试 ${JSON.stringify(d).slice(0, 200)}`;
  else if (r.type === 'session-log-deepseek/delivery-accepted') line = null;
  if (line) out.push(`- \`${local(r.time)}\` ${line}`);
}
out.push('');

// ---- 附录：统计 ----
const types = new Map();
for (const r of rows) types.set(r.type, (types.get(r.type) || 0) + 1);
out.push('## 四、附录：事件类型统计');
out.push('');
out.push('| 事件类型 | 条数 |');
out.push('| --- | --- |');
for (const [t, c] of [...types].sort((a, b) => b[1] - a[1])) out.push(`| \`${t}\` | ${c} |`);
out.push('');

const mdPath = path.join(outDir, `session-3cfb17ab-可读记录-${stamp}.md`);
fs.writeFileSync(mdPath, out.join('\n'), 'utf8');
console.log('\n=== 导出完成 ===');
console.log(`原始 JSONL: ${rawPath} (${(text.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`可读 Markdown: ${mdPath} (${(fs.statSync(mdPath).size / 1024).toFixed(0)} KB)`);
console.log(`真人输入 ${nUser} 条 / 助手消息 ${nAsst} 条`);
