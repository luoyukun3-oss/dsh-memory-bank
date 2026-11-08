// 联想收件箱（dream-inbox）—— 2026-10-18 用户拍板：「用 A 做收件箱，定时拉子代理审批」
// ============================================================
// 为什么要有这个模块（背景是查出来的，不是设想）：
//   `tick` 里的 ⑦ 做梦段（bank/dream.mjs）**早就在后台每 30 分钟跑**（Windows 计划任务
//   `DSH-Memory-Bank-Save` → `cli.mjs tick`），但候选只被 echo 进 `state/bank_tick.log`：
//   那个文件被 `>` **每次覆盖**、而且是 **GBK 乱码** ⇒ **产出没人吃**。实测 10-18 15:15
//   那次还在报「56 组候选」，而 `rel:` 边的建边路径（tools/rel-apply.mjs --apply）**从没
//   用真实数据跑过**。⇒ 本模块补的是**消费端**：把候选落成一份可审的队列，供定时子代理审。
//
// 三条设计约束（每条都对应一个踩过的坑）：
//   ① **绝不放在 `pages/` 里**：那里的一切都会被 index.json 收进召回，而本页内容是
//      「一堆条目标题 + 共享罕见词」⇒ 会变成**梦自己的新枢纽页**（`changelog.md` 那个病：
//      与谁都能撞罕见词）。放仓库根 ⇒ 不进召回、不进知识页索引、不被做梦当条目。
//      与 `mood.json` 同一策略：**隔离靠位置**，不靠提示词自觉。
//   ② **key 一律 fp() 归一化**（两侧字典序）：dream.mjs 用 fp 去查 killed，而
//      tools/rel-apply.mjs 写 discarded 时**双向都写**（实测 discards 里 `A|B` 与 `B|A`
//      并存）⇒ 收件箱若不归一化，同一对会在「已否决」和「待审」里各出现一次。
//   ③ **两条腿**：JSON 是真身（子代理读、CLI 改）、MD 是投影（人看）。**别手改 MD**。
//
// 状态机：pending（待审）→ approved（已建边）／rejected（已否决）／dropped（降级出队）。
//   dropped 只用于 pending 超过上限时按 overlap 淘汰 —— **不删**，留档可查。
// ============================================================

import path from 'node:path';
import crypto from 'node:crypto';
// ⚠️ 从 `core.mjs` 取、**不要**从 `bank.mjs` 取：`bank.mjs` 又 re-export 了 `bootstrap.mjs`，
// 而 bootstrap 要 import 本模块（注入段）⇒ 走 bank 会形成 bootstrap→dream-inbox→bank→bootstrap 的环。
// core 是叶子模块，从它取工具就没有环（2026-10-18 建模块时定的）。
import { readJson, writeJson, writeText } from './core.mjs';

const INBOX_JSON = 'dream-inbox.json';
const INBOX_MD = 'dream-inbox.md';
/** pending 上限：超了按 overlap 从低到高降级为 dropped（人审窗口别无限长）。 */
const MAX_PENDING = 80;
/** 正文片段长度：让子代理**不用翻页面**就能判（否则每组要多读两次文件）。 */
const SNIPPET = 240;
/** 状态白名单。 */
const STATUS = new Set(['pending', 'approved', 'rejected', 'dropped', 'stale']);

/** 与 dream.mjs 的 fp() 完全一致（两侧字典序 + `|`）—— 见模块头 ②。 */
export const fp = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** 内容指纹（2026-10-18 加）：`页#序号` 这种 id **会漂** —— 前文一增删，`#96` 就指向别处
 *  （我们踩过：教训页每加一条，后面所有 id 全体后移）。指纹取 title+text 的 sha1 前 12 位：
 *  位置变了它不变，内容改了它才变 —— 正好等于「同一对又出现」与「内容变了该重判」两个语义。 */
const hashOf = (d) => crypto.createHash('sha1')
  .update(String((d && d.title) || '') + '\n' + String((d && d.text) || ''))
  .digest('hex').slice(0, 12);

const snip = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET);

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

/**
 * 把一次「做梦」的结果并入收件箱。
 * @param {string} dir 仓库目录
 * @param {{candidates:Array}} r findDreamPairs() 的返回值
 * @param {{now?:Date}} [opts]
 * @returns {{added:number, refreshed:number, dropped:number, killed:number, pending:number}}
 */
export function ingestCandidates(dir, r, { now = new Date() } = {}) {
  const empty = { added: 0, refreshed: 0, dropped: 0, killed: 0, pending: 0 };
  if (!r || !Array.isArray(r.candidates)) return empty;

  const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
  const byId = new Map((idx.docs || []).map((d) => [d.id, d]));

  // 已否决集合（归一化，见模块头 ②）
  const killed = new Set();
  const dj = readJson(path.join(dir, 'dream-discarded.json'), { items: [] });
  for (const k of (dj.items || [])) {
    const [a, b] = String(k).split('|');
    if (a && b) killed.add(fp(a, b));
  }

  const box = loadInbox(dir);
  const byKey = new Map(box.items.map((it) => [it.key, it]));
  // 第二层去重：按内容指纹（条目换了位置但内容没变 ⇒ 同一对，不重复入队）
  const byHash = new Map();
  for (const it of box.items) if (it.hashA && it.hashB) byHash.set(fp(it.hashA, it.hashB), it);
  const iso = now.toISOString();
  let added = 0; let refreshed = 0; let nKilled = 0;

  for (const c of r.candidates) {
    const key = fp(c.a, c.b);
    if (killed.has(key)) { nKilled++; continue; }          // 已否决：永不入箱
    const A = byId.get(c.a) || {};
    const B = byId.get(c.b) || {};
    const ha = hashOf(A); const hb = hashOf(B); const hk = fp(ha, hb);
    const old = byKey.get(key) || byHash.get(hk);           // 先按 id，再按内容指纹
    if (old) {                                              // 已在箱：刷新观测值，**不改状态**
      if (!old.hashA) { old.hashA = ha; old.hashB = hb; }   // 老数据补指纹
      old.lastSeen = iso;
      old.shared = c.shared;
      old.overlap = c.overlap;
      old.words = (c.words || []).slice(0, 12);
      old.dayGap = c.dayGap ?? null;
      refreshed++;
      continue;
    }
    const it = {
      key,
      hashA: ha,
      hashB: hb,
      a: {
        id: c.a,
        page: c.pageA || A.page || String(c.a).split('#')[0],
        title: String(c.titleA || A.title || ''),
        snippet: snip(A.text),
      },
      b: {
        id: c.b,
        page: c.pageB || B.page || String(c.b).split('#')[0],
        title: String(c.titleB || B.title || ''),
        snippet: snip(B.text),
      },
      shared: c.shared,
      overlap: c.overlap,
      words: (c.words || []).slice(0, 12),
      dayGap: c.dayGap ?? null,
      score: c.score,
      firstSeen: iso,
      lastSeen: iso,
      status: 'pending',
    };
    box.items.push(it);
    byKey.set(key, it);
    added++;
  }

  // 清退（2026-10-18 加）：pending 里**已不在本次候选集**的 ⇒ `stale`。
  //   为什么必须做：候选集会变（规则收紧 / 条目被改写 / 条目被归档），不清退的话收件箱会
  //   永远挂着过时条目，人审还要为它们花钱。⚠️ 只在本次**确实产出候选**时清退 ——
  //   若某轮返回空（可能 index.json 异常），一律不动，避免把整箱清空。
  const liveKeys = new Set(r.candidates.map((c) => fp(c.a, c.b)));
  let staled = 0;
  if (liveKeys.size) {
    for (const it of box.items) {
      if (it.status === 'pending' && !liveKeys.has(it.key)) { it.status = 'stale'; staled++; }
    }
  }

  // pending 上限：按 overlap **降序**保留前 MAX_PENDING，其余降级（不是按时间淘汰 ——
  // 梦的价值在重叠度，旧候选未必更差；降级只意味着「这一轮不占人审窗口」）。
  const pend = box.items.filter((it) => it.status === 'pending');
  let dropped = 0;
  if (pend.length > MAX_PENDING) {
    pend.sort((x, y) => (y.overlap - x.overlap) || String(y.lastSeen).localeCompare(String(x.lastSeen)));
    for (const it of pend.slice(MAX_PENDING)) { it.status = 'dropped'; dropped++; }
  }
  // 补位（2026-10-18 实测加的）：pending 低于上限时，把先前被降级的候选**按 overlap 拉回来**。
  // 为什么必须补：不补的话 dropped 是**终态** —— 一旦被挤出窗口就永远进不了人审，
  //   而挤掉它的往往是「tick 刚抓到的新候选」，未必更好（这轮实测就有 5 条被挤掉）。
  let restored = 0;
  const pendingNow = box.items.filter((it) => it.status === 'pending').length;
  if (pendingNow < MAX_PENDING) {
    const back = box.items.filter((it) => it.status === 'dropped' && liveKeys.has(it.key))   // 只补仍在候选集里的
      .sort((x, y) => (y.overlap - x.overlap) || String(y.lastSeen).localeCompare(String(x.lastSeen)))
      .slice(0, MAX_PENDING - pendingNow);
    for (const it of back) { it.status = 'pending'; restored++; }
  }

  box.updatedAt = iso;
  saveInbox(dir, box);
  renderInboxMd(dir, box);
  return { added, refreshed, dropped, restored, staled, killed: nKilled, pending: box.items.filter((it) => it.status === 'pending').length };
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
