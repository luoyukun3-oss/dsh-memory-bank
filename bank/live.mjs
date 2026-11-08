// live —— 短期实时记忆：跨会话/跨壳共享「现在谁在干什么」。一会话一文件、全部容错、不进索引。
// 分工：handoff.md = 上一轮聊到哪（会话级）；live/ = 此刻谁在动（秒级、自动过期）。
// 细节与事故记录见 procedures.md「live 短期实时记忆」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `_dsh_memory` 根（本文件在 bank/ 下，向上一层即是）。 */
export const MEM_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const TTL_ACTIVE_MIN = 30;    // 进注入的新鲜度上限
const TTL_LIST_MIN = 120;     // 看板里还愿意列出来的上限
const MSG_CHARS = 60;         // 每会话记的「最后一句用户话」截断长度
const FILES_KEEP = 6;         // 每会话最多记几个刚改过的文件
const TEXT_BUDGET = 420;      // 注入段字数预算（含标题与来源脚注）

/** live 目录（root 默认 `_dsh_memory`，可传参以便测试用临时目录）。 */
function liveDir(root = MEM_ROOT) { return path.join(root, 'live'); }

/** 判断 hook 跑在哪个壳里。**优先看 `DSH_HOME`**（旧壳有值；官方版 hook 环境里它被 scrub 成空），
 *  `execPath` 只作兜底 —— 因为 hooks 统一走 node-run.cmd、它优先选官方 runtime 的 node.exe，
 *  按 execPath 判会把旧壳误记成 official（2026-09-30/10-04 两次实测，详见 procedures.md）。 */
function shellOf(execPath = process.execPath) {
  const home = String(process.env.DSH_HOME || '');
  if (/dsh-desktop/i.test(home)) return 'dsh-desktop';
  if (home) return 'custom-profile';
  const p = String(execPath || '');
  if (/DeepSeek Harness/i.test(p)) return 'official';
  if (/DSH Desktop/i.test(p)) return 'dsh-desktop';
  return 'unknown';
}

/** 安全文件名（sessionId 理论上安全，但不赌）。 */
function fileNameOf(id) { return `${String(id).replace(/[^\w.-]/g, '_')}.json`; }

/** 合并式更新一个会话的实时状态（读-改-写单文件）。任何失败都静默返回 false（受限沙箱写不进去是已知状态）。 */
export function touchLive(root, patch = {}) {
  try {
    const id = String(patch.sessionId || '');
    if (!id) return false;
    const dir = liveDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, fileNameOf(id));
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { /* 首次或坏文件都当空 */ }
    const now = Date.now();
    const added = (patch.files || []).map((p) => ({ path: String(p), at: now }));
    const next = {
      ...cur,
      ...patch,
      sessionId: id,
      shell: patch.shell || shellOf(),   // 每次都重算：判据被修正过（execPath→DSH_HOME），别沿用旧记录里判错的值
      startedAt: cur.startedAt || now,
      lastSeenAt: now,
      files: [...added, ...(cur.files || [])].slice(0, FILES_KEEP),
    };
    delete next.root;                      // 运行参数不落盘
    if (next.userMsg) next.userMsg = String(next.userMsg).slice(0, MSG_CHARS);
    fs.writeFileSync(f, JSON.stringify(next));
    return true;
  } catch { return false; }
}

/** 列出未过期的会话状态，按最后活动时间倒序。读失败一律当「没有」。 */
export function readLive(root = MEM_ROOT, opts = {}) {
  const out = [];
  const now = Date.now();
  const limitMs = (opts.listMin ?? TTL_LIST_MIN) * 60000;
  try {
    for (const name of fs.readdirSync(liveDir(root))) {
      if (!name.endsWith('.json')) continue;
      try {
        const o = JSON.parse(fs.readFileSync(path.join(liveDir(root), name), 'utf8'));
        if (now - Number(o.lastSeenAt || 0) > limitMs) continue;
        out.push(o);
      } catch { /* 单个坏文件不影响其余 */ }
    }
  } catch { return []; }
  return out.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

/** 「3 分钟前 / 刚刚」这种相对时间；超过一天给日期。 */
function agoText(ts, now = Date.now()) {
  const d = Math.max(0, now - Number(ts || 0));
  const min = Math.floor(d / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

/** 取路径末两段（够认出是哪个文件，又不至于把长路径塞进注入）。 */
function tail2(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * 生成注入段。**没有别的活跃会话时返回空串** —— 只有一个会话在跑时不灌废话。
 * @param root `_dsh_memory` 根
 * @param opts.selfId 当前会话 id（标成「本会话」）；opts.now 便于测试注入固定时刻
 */
export function liveText(root = MEM_ROOT, opts = {}) {
  const now = opts.now ?? Date.now();
  const activeMs = (opts.activeMin ?? TTL_ACTIVE_MIN) * 60000;
  const all = readLive(root, opts);
  if (!all.length) return '';
  const fresh = all.filter((o) => now - Number(o.lastSeenAt || 0) <= activeMs);
  const others = fresh.filter((o) => o.sessionId !== opts.selfId);
  // 只有自己一个在动 ⇒ 不注入（保持安静，别每轮都告诉用户「你在跟我说话」）
  if (!others.length) return '';

  // ⚠️ 不显示 shell 标签（2026-10-04 实测后去掉）：`shell` 字段**当前没有区分壳的能力** —— 7/7 个
  //    会话文件全记 official（hook 统一走 bank/hooks/node-run.cmd，它优先用官方 runtime 的 node.exe
  //    ⇒ shellOf 的 execPath 兜底判据恒真），摆在注入里只会让人以为是「官方版壳在跑」。字段照旧写进
  //    json 留档，只是不往注入里放 —— 宁缺勿误导。
  const line = (o) => '· ' + [agoText(o.lastSeenAt, now), o.turn ? `t${o.turn}` : '',
    o.userMsg ? `「${o.userMsg}」` : '', o.files && o.files[0] ? `·改 ${tail2(o.files[0].path)}` : ''].filter(Boolean).join(' ');
  // ⚠️ 明细只列**别人**（2026-09-30 实测首版把 self 也列进去了）：这段的全部意义就是「别的会话在干什么」，
  //    列自己既白占预算、又会让标题的计数与「别处」语义不符 —— 当前会话的状态我自己清楚。
  // ⚠️ 措辞必须与数据源同义（2026-10-04 血案）：本函数读的是 live/<sessionId>.json ⇒ 只谈得了「会话」，
  //    **谈不了壳**。旧文案那句「（本机两个壳都看得见彼此）」是照 2026-09-30 的真实场景写的修辞，而
  //    2026-10-04 用户据此以为本机被多开了新壳、甚至说想卸载 —— 实查：进程表只有 1 个 DSH Desktop.exe
  //    （PID 37708，7:54:39 起）、43129 端口只有 1 个监听者。⇒ 措辞＝事实，修辞不能替数据说话。
  const head = `【别处会话·实时】最近 ${Math.round(activeMs / 60000)} 分钟内另有 ${others.length} 个会话有活动（同一个壳里的其它会话，不是新开的壳）：`;
  const foot = '（显示的是各会话最后一次活动的时间，会过期；来源 `_dsh_memory/live/`，只列别的会话）';
  let body = others.map(line).join('\n');
  const room = TEXT_BUDGET - head.length - foot.length - 2;
  if (body.length > room) body = body.slice(0, Math.max(0, room - 1)) + '…';
  return `${head}\n${body}\n${foot}`;
}

/** 清理过期文件（供 tidy/tick 顺手调用；不做也不影响正确性，只是别让目录无限长）。 */
export function pruneLive(root = MEM_ROOT, opts = {}) {
  const limitMs = (opts.listMin ?? TTL_LIST_MIN) * 60000;
  const now = Date.now();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(liveDir(root))) {
      if (!name.endsWith('.json')) continue;
      const f = path.join(liveDir(root), name);
      // ⚠️ 2026-10-29：只清**本模块自己写的会话状态**，判据 = 带 `sessionId` 字段。
      //   live/ 目录里还住着别的功能的数据（handoff-state.json 只有 `sid`、todo-*.json、spike-*.json…），
      //   旧实现 catch 分支无条件 unlink ⇒ 会把它们当"坏文件"一起删掉。宁可漏清也不误删。
      try {
        const o = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!o || !o.sessionId) continue;
        if (now - Number(o.lastSeenAt || 0) > limitMs) { fs.unlinkSync(f); removed++; }
      } catch { /* 坏文件留着：可能是别的功能写到一半 */ }
    }
  } catch { /* 目录不存在等于没得清 */ }
  return removed;
}
