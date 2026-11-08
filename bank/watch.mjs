// ============================================================================
// Memory Bank · watch —— 「盯外部回复」（2026-09-30 新增）
//
// 治的病：2026-09-28 21:36 人家在 issue #1680 回了我们，**直到 09-29 下午才被用户告知** ——
// 人工盯不可靠。本模块把「盯谁 / 上次数到几条 / 有几条没读」落成本地状态，
// 再由注入层在开场**自动提醒**（纯读本地文件、零网络），把"记得查"变成"看得见"。
//
// 分工：本模块只做**本地状态与纯逻辑**（可单测）；真正发网络请求的是 `cli watch check`
// （走 gh CLI）—— 所以 hook 与注入层永远不会因为网络而卡住。
// ⚠️ 纪律：pending **只加不清**，要清必须显式 `cli watch read` —— 免得"提醒自己消失了"。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');            // _dsh_memory/
const watchFile = (memRoot = DEFAULT_ROOT) => path.join(memRoot, 'watch.json');

function loadWatch(memRoot) {
  try { return JSON.parse(fs.readFileSync(watchFile(memRoot), 'utf8')); } catch { return { items: [] }; }
}

function saveWatch(memRoot, data) {
  fs.writeFileSync(watchFile(memRoot), JSON.stringify(data, null, 2) + '\n');
  return data;
}

/** 登记一条要盯的目标（已存在则只更新 label）。 */
export function addWatch(memRoot, { repo, number, label, lastCount }) {
  const d = loadWatch(memRoot);
  d.items = d.items || [];
  const n = Number(number);
  const it = d.items.find((x) => x.repo === repo && x.number === n);
  if (it) {
    if (label) it.label = label;
    if (lastCount != null) it.lastCount = Number(lastCount);
  } else {
    d.items.push({
      repo, number: n, label: label || `#${n}`,
      lastCount: Number(lastCount || 0), lastCheckedAt: null, pending: [],
    });
  }
  saveWatch(memRoot, d);
  return d;
}

/** 用 gh 返回的 issue JSON 更新一条：评论数变多 ⇒ 新增的那些进 pending。
 *  ⚠️ `self` 是我们自己的 login：**自己发的评论不算「未读回复」**（否则每发一次帖就误报一次），
 *     但 `lastCount` 照常推进 —— 「计数」与「未读」是两件事。 */
export function applyIssue(memRoot, repo, number, issue, self) {
  const d = loadWatch(memRoot);
  const it = (d.items || []).find((x) => x.repo === repo && x.number === Number(number));
  if (!it) return { updated: false, reason: 'not-watched' };
  const comments = issue.comments || [];
  const prev = Number(it.lastCount || 0);
  const fresh = comments.slice(prev)
    .filter((c) => !self || (c.author?.login || '') !== self)
    .map((c) => ({
      author: c.author?.login || '?',
      createdAt: String(c.createdAt || ''),
      head: String(c.body || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }));
  it.lastCount = comments.length;
  it.state = issue.state || it.state || null;
  it.lastCheckedAt = new Date().toISOString();
  if (fresh.length) it.pending = [...(it.pending || []), ...fresh];
  saveWatch(memRoot, d);
  return { updated: true, fresh: fresh.length, total: comments.length };
}

/** 读完了就显式清（`cli watch read`）。清不掉不报错，只返回清了几条。 */
export function clearPending(memRoot, repo, number) {
  const d = loadWatch(memRoot);
  const it = (d.items || []).find((x) => x.repo === repo && x.number === Number(number));
  if (!it) return 0;
  const n = (it.pending || []).length;
  it.pending = [];
  saveWatch(memRoot, d);
  return n;
}

/** 注入用的一行；**没有任何未读时返回空串**（不占注入预算）。 */
export function pendingLine(memRoot) {
  const hot = (loadWatch(memRoot).items || []).filter((x) => (x.pending || []).length);
  if (!hot.length) return '';
  return hot.map((x) => {
    const p = x.pending[0];
    return `${x.label}（${x.repo}#${x.number}）有 ${x.pending.length} 条未读回复 —— @${p.author} ${p.createdAt.slice(0, 16)}：${p.head.slice(0, 90)}`;
  }).join('　｜　');
}

/** 清单（`cli watch` 无参时打印）。 */
export function listWatch(memRoot) {
  return (loadWatch(memRoot).items || []).map((x) => ({
    ...x,
    pendingCount: (x.pending || []).length,
  }));
}

// —— 渲染留在本模块（先例：dream / patch-status / dead-audit 都把打印放模块里），
//    这样 cli.mjs 只做分支调度，不必为"多一个命令"涨行数。
// ⚠️ `lastCheckedAt` 存的是 **UTC**（`toISOString()`）⇒ 显示时必须 +8h，
//    否则会看成"凌晨检查的"（同 2026-09-17「把 UTC 当本地、还说反作息」那条教训）。
const ts = (s) => {
  const t = Date.parse(String(s || ''));
  return Number.isFinite(t) ? new Date(t + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) : '';
};

/** 清单的人读格式。 */
export function formatWatchList(items) {
  if (!items.length) return '清单为空 —— 先 `cli watch add <owner/repo> <number> [--label 说明]`';
  return items.map((x) => `${x.pendingCount ? '●' : '○'} ${x.label}  ${x.repo}#${x.number}`
    + `  评论 ${x.lastCount} 条  未读 ${x.pendingCount}  上次检查 ${ts(x.lastCheckedAt) || '（从未）'}`).join('\n');
}

/** `check` 的单行结果。 */
export function formatCheckLine(it, res) {
  return `${res.fresh ? '●' : '○'} ${it.label}（${it.repo}#${it.number}）评论 ${res.total} 条`
    + (res.fresh ? ` —— **新增 ${res.fresh} 条**` : '，无变化');
}
