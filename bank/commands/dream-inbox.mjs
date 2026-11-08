// 联想收件箱的 CLI 子命令（2026-10-18）—— 从 cli.mjs **按域拆出**。
// 起因：cli.mjs 加完 dream-inbox 后实测 534 / 预算 510（105%）⇒ 按 budgets.json 的规矩「超限先按域拆分，
//   别压缩行宽硬塞」把 case 体搬出来；这也是 cli.mjs 从 10-13（cue/mood 那轮）就记下的欠账。
// 约定同 bank/commands/mood.mjs：本文件**不 import cli.mjs**（避免循环依赖），只接 cli 传来的上下文。
//
// 子命令：list（给人/子代理看的待审清单）｜brief（注入用一行）｜render（重渲染 MD）
//         ｜mark <key>... <status>（手工纠正）｜apply <verdicts.json> [--apply]（按裁决批量落）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fmtLocal, formatInboxBrief, loadInbox, markInbox, renderInboxMd } from '../dream-inbox.mjs';
import { applyWithLedger } from '../dream-apply.mjs';   // 落库：预检/锁/rel-apply/账本（2026-10-18 按域拆出）

/**
 * `cli dream-inbox [list|brief|render|mark|apply]`
 * @param {{positional:string[], argv:string[], dir:string, log:(s:string)=>void}} ctx
 */
export function runDreamInboxCommand({ positional = [], argv = [], dir, log }) {
  const sub = String(positional[0] || 'list').toLowerCase();
  if (sub === 'brief') { log(formatInboxBrief(dir) || '联想收件箱：空（无待审）'); return; }
  if (sub === 'render') { renderInboxMd(dir); log(`已渲染：${path.join(dir, 'dream-inbox.md')}`); return; }
  if (sub === 'list') {
    const box = loadInbox(dir);
    const items = box.items || [];
    const cnt = (s) => items.filter((it) => it.status === s).length;
    const pend = items.filter((it) => it.status === 'pending').sort((x, y) => y.overlap - x.overlap);
    log(`联想收件箱：pending ${pend.length} 条（approved ${cnt('approved')} / rejected ${cnt('rejected')} / dropped ${cnt('dropped')}）｜更新于 ${box.updatedAt ? fmtLocal(box.updatedAt) : '—'}`);
    if (!pend.length) { log('（暂无可审候选 —— 空箱正常：后台 tick 每 30 分钟会追加）'); return; }
    pend.forEach((it, i) => {
      const gap = (it.dayGap === null || it.dayGap === undefined) ? '' : `｜日期差 ${it.dayGap} 天`;
      log(`#${i + 1} ${it.key}  重叠 ${(it.overlap * 100).toFixed(0)}%｜共享 ${it.shared} 词：${(it.words || []).join('、')}${gap}`);
      log(`   A ${it.a.id}「${String(it.a.title).slice(0, 40)}」`);
      log(`     ${String(it.a.snippet).slice(0, 160)}`);
      log(`   B ${it.b.id}「${String(it.b.title).slice(0, 40)}」`);
      log(`     ${String(it.b.snippet).slice(0, 160)}`);
    });
    log('→ 逐组裁决后写 verdicts.json：[{a,b,verdict:"yes|no",type}]（type 白名单见 bank.mjs REL_TYPES），再 `dream-inbox apply <file> --apply`');
    return;
  }
  if (sub === 'mark') {
    const keys = positional.slice(1, -1);
    if (!keys.length) { log('用法：dream-inbox mark <key>... <pending|approved|rejected|dropped>'); return; }
    const st = String(positional[positional.length - 1]).toLowerCase();
    log(`已更新 ${markInbox(dir, keys, st)} 条 → ${st}`);
    return;
  }
  if (sub === 'apply') {
    const file = positional[1];
    if (!file) { log('用法：dream-inbox apply <verdicts.json> [--apply]'); return; }
    // ⚠️ 去 BOM：Windows 上 PowerShell/记事本写的 UTF-8 都带 BOM，JSON.parse 不认（同 rel-apply.mjs 的坑）
    const verdicts = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const write = argv.includes('--apply');
    const r = applyWithLedger(dir, path.resolve(file), verdicts, { dry: !write });
    if (!r.ok) {
      log('❌ 预检/加锁失败，**未写入任何东西**（整批不动，不做部分成功）：');
      for (const e of r.errors) log('  - ' + e);
      return;
    }
    for (const w of (r.warns || [])) log('  ⚠️ ' + w);
    if (r.dry) { log(`收件箱（干跑）：yes ${r.yes} → approved｜no ${r.no} → rejected（未写任何文件）`); return; }
    if (r.relOut) log(r.relOut);
    log(`收件箱：yes ${r.yes} → approved｜no ${r.no} → rejected`
      + (r.failed ? `｜建边失败 ${r.failed}（已标 approved-failed，不谎报成功）` : '')
      + (r.skipped && r.skipped.length ? '：' : ''));
    for (const [k, why] of (r.skipped || [])) log(`  - ${k}：${why}`);
    return;
  }
  log('用法：dream-inbox [list|brief|render|mark <key>... <status>|apply <verdicts.json> [--apply]]');
}
