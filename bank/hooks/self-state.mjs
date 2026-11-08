// ============================================================================
// Memory Bank · hooks/self-state —— 每轮注入的「[自身状态] 上下文 x%」段
// （2026-10-26 从 hooks/user-prompt.mjs 按域拆出：那边实测 186 / 预算 170 超限，
//   本表规矩是「超限先按域拆分，别压缩行宽」，先例：hooks/payload.mjs / bank/cue-suggest.mjs）
//
// 数据源 = DSH 自己写的 session_projcache（contextPressure.val）—— UI 面板上那个百分比就是它。
// ⚠️ 失败一律静默返回空串：hook 每轮都跑，绝不能因为读不到状态就拖累提问。
// ⚠️ 实测（2026-10-19）：全读 + JSON.parse 约 2.8 ms（137 KB 文件），不值得为它做缓存。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugOf } from '../core.mjs';

/** 组装「[自身状态]」那一行（含经验对照与压缩事后补注）。读不到就返回 ''（安静）。 */
export function readSelfState(payload) {
  try {
    // ⚠️ 2026-10-26 修两个叠加的 bug（用户当场点破「上下文 540 是上个会话，已经死了」）：
    //   ① 路径写死**旧壳** home（%APPDATA%\dsh-desktop\harness）—— 新壳跑在 ~/.dsh，
    //      本会话 id 在旧壳目录里当然找不到；
    //   ② 精确匹配的文件名**漏了 `.json`** ⇒ 永远匹配不上，于是每轮都走「按 mtime 取最新」兜底，
    //      兜到旧壳 2026-10-24 那个死会话（540K/1000K/23 轮），而真实值是 250K/1049K/14 轮。
    //   ⇒ 连续几轮我拿假数字当自己的状态、还据此催用户换会话。**错误的事实比没有事实更坏**，
    //      所以新版规则：跨 home 精确匹配优先；兜底只认「30 分钟内动过」的缓存；都没有就返回空串。
    const homes = [
      // ⚠️ 2026-11-08 发布前修：原先把 home 目录**写死成某台机器上的绝对路径** ——
      //    换台机器就没有这个目录，且把用户名固化进了代码。改走 os.homedir()（跨用户、跨平台）。
      path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'),
      path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'storages', 'session_projcache', 'sessions'),
      path.join(process.env.APPDATA || '', '@deepseek-ai', 'dsh-desktop', 'storages', 'session_projcache', 'sessions'),
    ].filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
    if (!homes.length) return '';
    const sid = String(payload.session_id || '');
    let target = '';
    // —— ① 精确匹配（跨所有 home）：文件名必须带 .json
    if (sid) {
      const file = (sid.startsWith('session-') ? sid : 'session-' + sid) + '.json';
      for (const d of homes) {
        const p = path.join(d, file);
        try { if (fs.existsSync(p)) { target = p; break; } } catch {}
      }
    }
    // —— ② 兜底：只认「最近 30 分钟内写过」的缓存，死会话的残留不许再冒充当前会话
    if (!target) {
      const FRESH_MS = 30 * 60 * 1000;
      let newest = 0;
      for (const d of homes) {
        let list = [];
        try { list = fs.readdirSync(d); } catch { continue; }
        for (const f of list) {
          if (!f.endsWith('.json')) continue;
          const p = path.join(d, f);
          try {
            const m = fs.statSync(p).mtimeMs;
            if (m > newest && Date.now() - m < FRESH_MS) { newest = m; target = p; }
          } catch {}
        }
      }
    }
    if (!target) return '';
    const rows = JSON.parse(fs.readFileSync(target, 'utf8'))?.record?.rows;
    const v = rows?.contextPressure?.val;
    if (!v || !v.contextWindow) return '';
    const pct = Math.round((v.pressureTokens / v.contextWindow) * 100);
    const k = (n) => (n >= 10000 ? Math.round(n / 1000) + 'K' : String(n));
    const turns = rows?.sessionStats?.val?.turns;
    let s = '[自身状态] 上下文 ' + pct + '%（' + k(v.pressureTokens) + ' / ' + k(v.contextWindow) + '）';
    if (turns) s += '｜' + turns + ' 轮';
    // 阈值报警（2026-10-19）：事实本身不动判断，只有越过红线才改变措辞 —— 让"需求"真的影响行为
    if (pct >= 80) s += ' ⚠️已过 80%，优先减负（先存档，少说两句）';
    const cwd0 = path.resolve(payload.cwd || 'E:\\2');
    const repoDir = path.join(cwd0, '_dsh_memory', 'repos', slugOf(cwd0));
    // —— 经验对照（2026-10-19 选题 A）：阈值不是常数，而是「历史上出过事的位置」的投影。
    try {
      const pts = (JSON.parse(fs.readFileSync(path.join(repoDir, 'state', 'context-gauge.json'), 'utf8')).points) || [];
      if (pts.length) {
        const past = pts.filter((x) => x <= v.pressureTokens).length;
        s += '｜经验：出事点 ' + pts.map((x) => Math.round(x / 1000) + 'K').join('/') + '（已越过 ' + past + ' 个）';
      }
    } catch {}
    // —— 压缩后补注入（2026-10-21 用户定）：handoff 只在开场注入，压缩会把它裁掉。
    //   判据：同一会话内 pressure 突然掉到上次的 75% 以下 ⇒ 被压缩了。状态存 live/（实测 hook 能写）。
    try {
      const st = path.join(cwd0, '_dsh_memory', 'live', 'handoff-state.json');
      let last = null;
      try { last = JSON.parse(fs.readFileSync(st, 'utf8')); } catch {}
      if (last && last.sid === sid && last.p > 0 && v.pressureTokens < last.p * 0.75) {
        const ho = fs.readFileSync(path.join(repoDir, 'pages', 'handoff.md'), 'utf8').split('\n').slice(0, 14).join('\n');
        s += '\n【压缩后补·上次聊到哪】\n' + ho;
      }
      try { fs.writeFileSync(st, JSON.stringify({ sid, p: v.pressureTokens, t: turns, at: Date.now() })); } catch {}
    } catch {}
    return s;
  } catch { return ''; }
}
