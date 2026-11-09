// ============================================================================
// test-mood-danger.mjs —— 「危险档必须告警」的守护（2026-11-09）
//
// 跑法：
//   node -e "import('./test-mood-danger.mjs').then(m=>m.runMoodDangerTests({ok:(c,l,d)=>console.log(c?'OK':'FAIL',l,c?'':(' << '+d))}))"
//
// 守三件事：
//   ① **面板与真相源不漂移**：`dsh-mood-panel/lib/client.js` 里抄了一份 `DANGER_LEVELS`（前端拿不到
//      host 的常量），必须与 `config-keys.mjs` 的 `MOOD_DANGER_LEVELS` 逐项一致；
//   ② **CLI 两侧都真的会说**：切到 danger/extreme 要告警、`show` 在危险档下也要告警、切回普通档不再报；
//   ③ **裸写要留痕提示**：危险档下不给 `--evidence` 写气氛 ⇒ 必须明说「已打 unsafe」。
//
// ⚠️ 只测**提示**，不测也不改行为：`score` 在任何档位下不变的铁律由 `test-mood.mjs` 那条断言守着
//    （那边已有「★ 守线：换档位时 score 一个字都不许变」），这里不重复造第二份判据。
// ⚠️ 全程用**临时目录**跑，绝不碰 `repos/e-2/mood.json` 与真实档位。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MOOD_DANGER_LEVELS } from './config-keys.mjs';
import { runMoodCommand } from './commands/mood.mjs';

/** 面板源码位置（两个壳的 `.local-bundles/dsh-mood-panel` 都是 junction 指向这里）。 */
const PANEL = 'E:/2/dsh-mood-panel/lib/client.js';

export function runMoodDangerTests({ ok }) {
  console.log('== 46. 情绪危险档的告警（CLI + 面板两侧，2026-11-09） ==');
  // —— ① 面板常量与 config-keys 不漂移 ——
  const src = fs.existsSync(PANEL) ? fs.readFileSync(PANEL, 'utf8') : '';
  const m = src.match(/const DANGER_LEVELS = \[([^\]]*)\]/);
  const panelLevels = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  ok(panelLevels.length > 0, '面板 client.js 里能读到 DANGER_LEVELS 声明', m ? m[0] : '没找到（改了变量名？同步改本测试）');
  ok(JSON.stringify([...panelLevels].sort()) === JSON.stringify([...MOOD_DANGER_LEVELS].sort()),
    `面板的 DANGER_LEVELS 与 config-keys 的 MOOD_DANGER_LEVELS 完全一致（面板 ${panelLevels.join('/')}）`);
  ok(/DANGER_LEVELS\.indexOf\(item\.level\)/.test(src), '面板的档位按钮/切换逻辑真的用了这个常量（不是声明了没人用）');
  ok(/kind:\s*"err"/.test(src), '面板的危险档提示走 kind:"err"（红色 banner），不是普通灰字');

  // —— ②③④ CLI 端到端（临时目录，绝不碰真实数据）——
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mooddanger-'));
  const run = (sub, o = {}, arg) => {
    const out = [];
    process.exitCode = 0;
    runMoodCommand({ sub, arg, opt: (n, fb) => (n in o ? o[n] : fb), log: (s) => out.push(String(s)), dir });
    return out.join('\n');
  };
  const tail = (s, n = 5) => s.split('\n').slice(-n).join(' | ');

  const tDanger = run('weight', {}, 'danger');
  ok(/危险档/.test(tDanger) && /提前注入/.test(tDanger) && /裸写/.test(tDanger) && /score/.test(tDanger),
    '切到 danger：告警里点名两条地基 + 「score 不变」', tail(tDanger));
  const tExtreme = run('weight', {}, 'extreme');
  ok(/危险档/.test(tExtreme), '切到 extreme 同样告警（不只管 danger 一个）', tail(tExtreme));
  const tShow = run('show');
  ok(/危险档/.test(tShow), '危险档下 `mood show` 也带告警（否则关掉终端再打开就没痕迹了）', tail(tShow));
  const tBare = run('set', { label: '临时测试' });
  ok(/裸写/.test(tBare) && /unsafe/.test(tBare), '危险档下不给 --evidence 写气氛 ⇒ 明确说「已打 unsafe 留痕」', tail(tBare));

  const tMid = run('weight', {}, 'mid');
  ok(!/危险档/.test(tMid), '切回 mid **不再**告警（不是"所有档位都报"）', tail(tMid));
  const tShowMid = run('show');
  ok(!/危险档/.test(tShowMid), '普通档下 `mood show` 无告警（不制造噪声）', tail(tShowMid));
  const tSetOk = run('set', { label: '临时测试2', reason: '改标签', evidence: '这是一句足够长的测试证据' });
  ok(!/裸写/.test(tSetOk), '普通档 + 有证据 ⇒ 无裸写提示（不误报）', tail(tSetOk));

  fs.rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
}
