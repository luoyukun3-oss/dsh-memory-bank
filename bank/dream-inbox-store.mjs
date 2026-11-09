// ============================================================================
// Memory Bank · dream-inbox-store —— 联想收件箱的**存储与渲染**（2026-11-09 从 dream-inbox.mjs 按域拆出）
//
// 为什么拆：`dream-inbox.mjs` 已到 **260/270 行（96%）**，逼近 `budgets.json` 的架构红线；
//   而那个文件里本来就塞着两件不同的事：
//     ① **入队与筛选**（ingestCandidates：去重 → 清退 → 上限降级 → 补位，会写盘、有状态机）；
//     ② **读与渲染**（loadInbox / saveInbox / renderInboxMd / formatInboxBrief / markInbox：把 JSON 真身读出来、
//        投影成 md、压成开场一行摘要）—— 只关心「怎么存、怎么写给人看」。
//   本文件是 ②，① 留在 `dream-inbox.mjs`。
//
// ⚠️ 依赖方向只有一个：`dream-inbox.mjs` → 本文件。**本文件不许 import dream-inbox.mjs**（会成环）。
// ⚠️ 为什么工具从 `core.mjs` 取、**不用** `bank.mjs`：`bank.mjs` 又 re-export 了 `bootstrap.mjs`，
//   而 bootstrap 要 import 收件箱（开场注入段）⇒ 走 bank 会形成 bootstrap→dream-inbox→bank→bootstrap 的环。
//   core 是叶子模块，从它取工具就没有环（2026-10-18 建模块时定的）。
// ⚠️ 对外零变化：`dream-inbox.mjs` 继续 re-export 本文件的全部导出 ⇒ 老路径（dream-apply.mjs /
//   commands/dream-inbox.mjs / bootstrap.mjs）一个字都不用改。
// ============================================================================

import path from 'node:path';
import { readJson, writeJson, writeText } from './core.mjs';

const INBOX_JSON = 'dream-inbox.json';
const INBOX_MD = 'dream-inbox.md';
/** 状态白名单。 */
const STATUS = new Set(['pending', 'approved', 'rejected', 'dropped', 'stale']);

/** 与 dream.mjs 的 fp() 完全一致（两侧字典序 + `|`）—— 见 dream-inbox.mjs 模块头 ②。 */
export const fp = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** 时间戳展示：JSON 里存的是 UTC ISO（与 index.json 一致），**给人看的一律转本地**。
 *  为什么不一并存本地：跨时区/夏令时不可靠，且会把「同一时刻」写成两种格式；
 *  为什么展示要转：实测 md 里写成 `2026-10-18T07:22Z` 会被误读成北京时间 07:22（实际 15:22）。 */
export function fmtLocal(iso) {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return String(iso || '—');
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
/** 只取本地日期（brief 里「最早/最近」用）。 */
const localDay = (iso) => fmtLocal(iso).slice(0, 10);

/** 读收件箱（缺文件＝空箱，不是错误）。 */
export function loadInbox(dir) {
  const d = readJson(path.join(dir, INBOX_JSON), null);
  if (d && Array.isArray(d.items)) return d;
  return { version: 1, updatedAt: null, items: [] };
}

/** 写收件箱（JSON 真身）。 */
export function saveInbox(dir, box) {
  writeJson(path.join(dir, INBOX_JSON), box);
}

/** 把收件箱渲染成 `dream-inbox.md`（人看 + 子代理看的投影；真身是 JSON）。 */
export function renderInboxMd(dir, box = loadInbox(dir)) {
  const items = Array.isArray(box.items) ? box.items : [];
  const cnt = (s) => items.filter((it) => it.status === s).length;
  const pend = items.filter((it) => it.status === 'pending')
    .sort((x, y) => (y.overlap - x.overlap) || (y.shared - x.shared));
  const L = [];
  L.push('# 联想收件箱（dream-inbox）');
  L.push('');
  L.push('> 由 `cli.mjs tick` 自动追加「做梦」候选（**只报告、不动库**）；审批后状态会变。');
  L.push('> ⚠️ 本页 **不在 `pages/` 里**：不参与召回、不被当成知识页、也不会变成做梦的新枢纽页。');
  L.push('> 🔁 数据真身＝同目录 `dream-inbox.json`，本页只是它的投影（**别手改本页**）。');
  L.push('> 🧹 审批：`node E:\\2\\_dsh_memory\\bank\\cli.mjs dream-inbox list`；裁决写文件后跑 `dream-inbox apply <verdicts.json> --apply`。');
  L.push('');
  L.push('**待审 pending：' + pend.length + ' 条**（approved ' + cnt('approved') + ' ／ rejected ' + cnt('rejected') + ' ／ dropped ' + cnt('dropped') + '）｜更新于 ' + (box.updatedAt ? fmtLocal(box.updatedAt) : '—'));
  L.push('');
  if (!pend.length) L.push('（暂无可审候选）');
  pend.forEach((it, i) => {
    const gap = (it.dayGap === null || it.dayGap === undefined) ? '日期未知' : ('日期差 ' + it.dayGap + ' 天');
    L.push('## ' + (i + 1) + '. `' + it.a.id + ' × ' + it.b.id + '`');
    L.push('- 重叠 ' + (it.overlap * 100).toFixed(0) + '%｜共享 ' + it.shared + ' 词：' + (it.words || []).join('、') + '｜' + gap);
    L.push('- A `' + it.a.id + '`「' + String(it.a.title).slice(0, 40) + '」');
    L.push('  > ' + it.a.snippet);
    L.push('- B `' + it.b.id + '`「' + String(it.b.title).slice(0, 40) + '」');
    L.push('  > ' + it.b.snippet);
    L.push('');
  });
  const done = items.filter((it) => it.status !== 'pending');
  if (done.length) {
    L.push('---');
    L.push('');
    L.push('## 已处理（' + done.length + ' 条，只登记不复述）');
    L.push('');
    for (const it of done.slice(-60).reverse()) {
      L.push('- `' + it.key + '` → **' + it.status + '**' + (it.relType ? ('（' + it.relType + '）') : '') + '（' + fmtLocal(it.lastSeen || it.firstSeen) + '）');
    }
    L.push('');
  }
  writeText(path.join(dir, INBOX_MD), L.join('\n'));
}

/** 开场注入用的一行摘要；空箱返回 ''（与 inbox / watch / mood 段同一策略：不占预算）。 */
export function formatInboxBrief(dir) {
  const box = loadInbox(dir);
  const pend = (box.items || []).filter((it) => it.status === 'pending');
  if (!pend.length) return '';
  const days = pend.map((it) => localDay(it.firstSeen)).sort();
  return '【联想收件箱】' + pend.length + ' 条「做梦」候选**待审**（最早 ' + days[0] + '、最近 ' + days[days.length - 1] + '）—— 后台 tick 每 30 分钟自动追加，**没人审就只是排队**。\n→ 审它：`node E:\\2\\_dsh_memory\\bank\\cli.mjs dream-inbox list`（流程见 todos.md 的定时条目）';
}

// `applyVerdicts` 已按域搬到 `dream-apply.mjs`（2026-10-18：它属于「落库/执行」域，而本文件只管队列）。

/** 单条改状态（手工纠正用）。 */
export function markInbox(dir, keys, status) {
  if (!STATUS.has(status)) throw new Error('未知状态 ' + status + '（允许：' + [...STATUS].join('/') + '）');
  const box = loadInbox(dir);
  const want = new Set(keys.map((k) => {
    const [a, b] = String(k).split('|');
    return fp(a || '', b || '');
  }));
  let n = 0;
  for (const it of box.items) {
    if (!want.has(it.key)) continue;
    if (it.status !== status) { it.status = status; n++; }
  }
  box.updatedAt = new Date().toISOString();
  saveInbox(dir, box);
  renderInboxMd(dir, box);
  return n;
}
