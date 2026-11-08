// ============================================================================
// read-thread —— 读一个 GitHub Discussion 的【全部】评论（顶层 + replies，展平、按时间）
//
// 为什么需要它：GitHub 的 `discussion.comments` **不含** `replies` —— 回复挂在
// `comment.replies` 里。2026-10-06 我因此看漏/看错七八次（#7123 / #8798 / #8634 /
// #8801 / #3349 / #8364 / #7865 / #8138）。
//
// v2 修掉两类毛病（用户 2026-10-06：「每次都是多查漏查」）：
//   ▸ 漏查：--tail 会丢掉夹在中间的新回复；shell 的 Select-Object 会截断输出；
//           `first:100` 之外的内容看不见。
//   ▸ 多查：把我们自己发的当成"有人回复了新东西" —— 工具没有"上次读到哪"的概念。
//   ⇒ 对策：--since-me（只显示我们最后一条之后）+ 每行都标 (我们) + 翻页 + 计数对账。
//
// 用法：
//   node tools/read-thread.mjs <owner/repo> <number>             全量（正文截 1200 字）
//   node tools/read-thread.mjs <owner/repo> <number> --replies-to-me  ★★ 只看"挂在我们评论下、作者不是我们"的回复（结构判据，最可靠）
//   node tools/read-thread.mjs <owner/repo> <number> --since-me      只看我们最后一条之后的（按时间，可能漏，见下）
//   node tools/read-thread.mjs <owner/repo> <number> --brief     ★ 一行一条（时间/作者/首行）
//   node tools/read-thread.mjs <owner/repo> <number> --full      不截断正文
//   node tools/read-thread.mjs <owner/repo> <number> --ids       只列 id/作者/时间（找评论 id）
//   node tools/read-thread.mjs <owner/repo> <number> --mine      只看我们发的
//   node tools/read-thread.mjs <owner/repo> <number> --tail N    只看最后 N 条
//   node tools/read-thread.mjs <owner/repo> <number> --len 3000  自定义截断长度
//
// 每次都会打印「顶层 X + 回复 Y = 共 Z」并与 GraphQL 的 totalCount 对账，不一致会警告。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ⚠️ 2026-11-08 发布前修：兜底值原写死作者自己的 GitHub 账号 —— 换成空串。
//    用 --mine / --since-me 这类要判断「哪些是我发的」的功能时，必须自己设 DSH_THREAD_ME。
const ME = process.env.DSH_THREAD_ME || '';
const [, , repoArg, numArg, ...rest] = process.argv;
const usage = '用法：node tools/read-thread.mjs <owner/repo> <number> [--since-me] [--brief] [--full] [--ids] [--mine] [--tail N] [--len N]';
if (!repoArg || !numArg || !/^\d+$/.test(numArg)) { console.log(usage); process.exit(2); }
const [owner, name] = repoArg.split('/');
if (!owner || !name) { console.log(usage); process.exit(2); }
const has = (k) => rest.includes('--' + k);
const val = (k, d) => { const i = rest.indexOf('--' + k); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : d; };

const brief = has('brief');
const idsOnly = has('ids');
const full = has('full');
const mineOnly = has('mine');
const sinceMe = has('since-me');
const repliesToMe = has('replies-to-me');
const tail = Number(val('tail', 0)) || 0;
const len = full ? Infinity : (Number(val('len', 1200)) || 1200);

const QUERY = [
  'query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name){',
  '  discussion(number:$n){ number title url createdAt closed',
  '    author{login} category{name}',
  '    comments(first:100,after:$after){ totalCount pageInfo{ hasNextPage endCursor }',
  '      nodes{ id author{login} createdAt body',
  '        replies(first:100){ nodes{ id author{login} createdAt body } } } } } } }',
].join('\n');

const fetchPage = (after) => {
  const f = path.join(os.tmpdir(), 'dsh-read-thread-' + process.pid + '.json');
  fs.writeFileSync(f, JSON.stringify({ query: QUERY, variables: { owner, name, n: Number(numArg), after: after || null } }), 'utf8');
  const r = spawnSync('gh', ['api', 'graphql', '--input', f], { encoding: 'utf8' });
  fs.rmSync(f, { force: true });
  if (r.status !== 0) return { error: 'gh 调用失败：' + String(r.stderr).slice(0, 300) };
  let j; try { j = JSON.parse(r.stdout); } catch (e) { return { error: '响应无法解析：' + e.message }; }
  if (j.errors) return { error: 'GraphQL 报错：' + JSON.stringify(j.errors).slice(0, 300) };
  return { d: j.data.repository.discussion };
};

const first = fetchPage(null);
if (first.error) { console.log('✗ ' + first.error); process.exit(1); }
const d = first.d;
const all = [];
let page = { nodes: d.comments.nodes, pageInfo: d.comments.pageInfo };
let guard = 0;
while (page && guard++ < 20) {
  for (const c of page.nodes || []) {
    const topAuthor = c.author ? c.author.login : null;
    all.push({ depth: 0, parentId: null, parentAuthor: null, ...c });
    for (const rp of c.replies?.nodes || []) all.push({ depth: 1, parentId: c.id, parentAuthor: topAuthor, ...rp });
  }
  if (!page.pageInfo?.hasNextPage) break;
  const nx = fetchPage(page.pageInfo.endCursor);
  if (nx.error) { console.log('⚠️ 翻页中断：' + nx.error); break; }
  page = { nodes: nx.d.comments.nodes, pageInfo: nx.d.comments.pageInfo };
}
all.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

const tops = all.filter((c) => c.depth === 0).length;
const reps = all.length - tops;
const mine = all.filter((c) => c.author && c.author.login === ME);
const lastMineIdx = all.reduce((k, c, i) => (c.author && c.author.login === ME ? i : k), -1);
const afterMe = lastMineIdx >= 0 ? all.slice(lastMineIdx + 1) : all;
// ★ 结构判据（不依赖时间）：挂在【我们的评论】下面、作者又不是我们的 —— 这才是"有人回了我"。
//   --since-me 按时间切片，若我在对方回复之后又发过一条，对方的回复会被漏在外面（2026-10-06 真踩过）。
const repliesToMeList = all.filter((c) => c.depth === 1 && c.parentAuthor === ME && (!c.author || c.author.login !== ME));

console.log('#' + d.number + '  ' + d.title);
console.log('@' + (d.author ? d.author.login : '?') + '｜' + (d.category ? d.category.name : '?') + '｜' + String(d.createdAt).slice(0, 16) + '｜' + (d.closed ? '已关闭' : '进行中'));
console.log(d.url);
console.log('顶层 ' + tops + ' + 回复 ' + reps + ' = 共 ' + all.length + ' 条'
  + (tops !== Number(d.comments.totalCount) ? '   ⚠️ 顶层数(' + tops + ')≠ totalCount(' + d.comments.totalCount + ')' : '')
  + (guard >= 20 ? '   ⚠️ 翻页达上限，可能未取全' : ''));
console.log('我们发了 ' + mine.length + ' 条；挂在我们评论下的他人回复 ' + repliesToMeList.length + ' 条'
  + (repliesToMeList.length ? '（★ 用 --replies-to-me 看）' : '')
  + '；按时间算，最后一条之后还有 ' + afterMe.length + ' 条'
  + (afterMe.length ? '' : '（注意：时间判据可能漏掉"对方在我之后发、我又在对方之后发"的回复，看上面的结构计数）'));

let list = all;
if (mineOnly) list = mine;
else if (repliesToMe) list = repliesToMeList;
else if (sinceMe) list = afterMe;
if (tail > 0) list = list.slice(-tail);

if (idsOnly) {
  console.log('\n-- id / 作者 / 时间 --');
  for (const c of list) console.log('  ' + (c.depth ? '  └ ' : '') + c.id + '  @' + (c.author ? c.author.login : '?') + '  ' + String(c.createdAt).slice(5, 16));
  process.exit(0);
}

if (brief) {
  console.log('\n-- 一行一条（时间｜作者｜首行）--');
  for (const c of list) {
    const who = c.author ? c.author.login : '?';
    const firstLine = String(c.body || '').replace(/\r/g, '').split('\n').find((x) => x.trim()) || '';
    console.log('  ' + (c.depth ? '  └' : '   ') + '[' + String(c.createdAt).slice(5, 16) + '] @' + who + (who === ME ? '(我们)' : '')
      + '  ' + firstLine.replace(/[#*`>]/g, '').trim().slice(0, 90));
  }
  process.exit(0);
}

if (!list.length) { console.log('\n（没有要显示的内容' + (sinceMe ? '：我们最后一条之后没有新评论' : '') + '）'); process.exit(0); }

console.log('\n-- 评论（时间正序；缩进＝回复）--');
for (const c of list) {
  const who = c.author ? c.author.login : '?';
  console.log('\n' + (c.depth ? '    └ ' : '') + '[' + String(c.createdAt).slice(5, 16) + '] @' + who + (who === ME ? ' ★我们' : ''));
  const b = String(c.body || '').replace(/\r/g, '');
  console.log('  ' + (full ? b : b.slice(0, len)).split('\n').join('\n  '));
  if (!full && b.length > len) console.log('  …（本条还有 ' + (b.length - len) + ' 字，用 --full 看全）');
}
