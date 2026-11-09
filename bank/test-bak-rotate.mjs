// ============================================================================
// test-bak-rotate.mjs —— 第 40 节：备份轮转（2026-11-09）
//
// 这是**删文件**的逻辑，所以测试的重点不是"能删"，而是**不删错的**：
//   ① `_bak/` 下的人工快照**一个都不能进 del 名单**（AGENTS.md 规定那是给人留的）
//   ② 每个原文件**最近 K 份必须保住**（否则回滚能力没了）
//   ③ 每天最后一份必须保住（否则"上周三那版长什么样"查不到）
//   ④ 默认 **dry-run**：不传 apply 时磁盘上一个文件都不能少
//   ⑤ 份数没超 K 的文件，一份都不该删
//
// ⚠️ 全是临时目录造数据，绝不碰真实 `_dsh_memory`。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanBackups, planRotation, applyRotation, KEEP_PER_FILE, KEEP_DAILY_DAYS } from './bak-rotate.mjs';

const DAY = 86400000;

/** 造一个临时 _dsh_memory 树：pages 下 n 份备份 + `_bak` 下 m 份人工快照。 */
function makeTree({ autoCount = 12, manualCount = 3, base = 'lessons.md', daysAgoFrom = 0 } = {}) {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rotate-'));
  const pd = path.join(R, 'pages');
  const bd = path.join(R, 'pages', '_bak');
  fs.mkdirSync(pd, { recursive: true });
  fs.mkdirSync(bd, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < autoCount; i++) {
    const p = path.join(pd, `${base}.bak-2026010${(i % 9) + 1}-0000${i}`);
    fs.writeFileSync(p, 'x'.repeat(100), 'utf8');
    // 每个比前一个早 1 小时（同一批都在相近时间，模拟"高频修改堆出来"）
    const t = new Date(now - (i * 3600000) - daysAgoFrom * DAY);
    fs.utimesSync(p, t, t);
  }
  for (let i = 0; i < manualCount; i++) {
    const p = path.join(bd, `${base}.bak-manual-${i}`);
    fs.writeFileSync(p, 'm'.repeat(100), 'utf8');
    const t = new Date(now - (i + 40) * DAY);   // 很老也不行 —— _bak 永远不删
    fs.utimesSync(p, t, t);
  }
  return R;
}

export function runBakRotateTests({ ok }) {
  console.log('== 40. 备份轮转：只删自动产物、保住最近 K 份与每天最后一份（2026-11-09） ==');

  // ① _bak/ 下的人工快照**绝不进 del 名单**
  {
    const R = makeTree({ autoCount: 20, manualCount: 5 });
    const { auto, manual } = scanBackups(R);
    ok(manual.length === 5, `扫到 5 份人工快照（实得 ${manual.length}）`);
    ok(auto.length === 20, `扫到 20 份自动产物（实得 ${auto.length}）`);
    const plan = planRotation(auto);
    const manualInDel = plan.del.filter((r) => r.rel.includes('_bak'));
    ok(manualInDel.length === 0, `del 名单里没有任何 _bak 路径（实得 ${manualInDel.length} 个）`);
    fs.rmSync(R, { recursive: true, force: true });
  }

  // ② 最近 K 份必须保住
  {
    const R = makeTree({ autoCount: 20 });
    const { auto } = scanBackups(R);
    const plan = planRotation(auto, { keepPerFile: KEEP_PER_FILE, keepDailyDays: 0 });   // 关掉"每天最后一份"单独测 K
    const kept = plan.keep.map((r) => r.abs);
    const sorted = [...auto].sort((a, b) => b.mtime - a.mtime);
    const newestK = sorted.slice(0, KEEP_PER_FILE).map((r) => r.abs);
    ok(newestK.every((p) => kept.includes(p)), `最近 ${KEEP_PER_FILE} 份全部保留`);
    ok(plan.del.length === 20 - KEEP_PER_FILE, `其余 ${20 - KEEP_PER_FILE} 份进 del（实得 ${plan.del.length}）`);
    fs.rmSync(R, { recursive: true, force: true });
  }

  // ③ 份数没超 K ⇒ 一份都不删
  {
    const R = makeTree({ autoCount: 4 });
    const { auto } = scanBackups(R);
    const plan = planRotation(auto, { keepPerFile: KEEP_PER_FILE });
    ok(plan.del.length === 0, `只有 4 份（< K）⇒ 一个都不删（实得 ${plan.del.length}）`);
    fs.rmSync(R, { recursive: true, force: true });
  }

  // ④ 默认 dry-run：不传 apply 时磁盘文件数不变
  {
    const R = makeTree({ autoCount: 20 });
    const before = scanBackups(R).auto.length;
    const plan = planRotation(scanBackups(R).auto);
    const r = applyRotation(plan);                     // 不传 apply
    const after = scanBackups(R).auto.length;
    ok(before === after, `dry-run 后文件数不变（${before} → ${after}）`);
    ok(r.deleted > 0, `dry-run 仍如实报告"将删 ${r.deleted} 个"`);
    fs.rmSync(R, { recursive: true, force: true });
  }

  // ⑤ apply 真的删，且删完只剩保留的
  {
    const R = makeTree({ autoCount: 20, manualCount: 4 });
    const plan = planRotation(scanBackups(R).auto);
    const wantDel = plan.del.length;
    const res = applyRotation(plan, { apply: true });
    ok(res.deleted === wantDel, `实际删了 ${res.deleted} 个（计划 ${wantDel}）`);
    const after = scanBackups(R);
    ok(after.auto.length === plan.keep.length, `删后剩 ${after.auto.length} 个 = 计划保留 ${plan.keep.length} 个`);
    ok(after.manual.length === 4, `人工快照一个没少（仍 ${after.manual.length} 个）`);
    fs.rmSync(R, { recursive: true, force: true });
  }

  // ⑥ 每天最后一份：跨多天的数据，即使超出 K 也要留
  //    ⚠️ 基准用**固定 UTC 中午**，不能用 `Date.now()` ——
  //    实测踩过：本地 08:23 = UTC 00:23，减 2 小时就落到前一个 UTC 日，
  //    于是"6 天"变成了 7 个 UTC 日期、断言假红。日期分桶按 UTC 算，造数据就必须对齐 UTC。
  {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-rotate-'));
    const pd = path.join(R, 'pages');
    fs.mkdirSync(pd, { recursive: true });
    const base = Date.UTC(2026, 10, 1, 12, 0, 0);   // 2026-11-01 12:00 UTC
    // 每天 3 份，共 6 天 = 18 份
    for (let d = 0; d < 6; d++) {
      for (let k = 0; k < 3; k++) {
        const p = path.join(pd, `lessons.md.bak-d${d}-k${k}`);
        fs.writeFileSync(p, 'x'.repeat(50), 'utf8');
        const t = new Date(base - d * DAY - k * 3600000);   // 都在当天 UTC 12:00 之前，不跨天
        fs.utimesSync(p, t, t);
      }
    }
    const { auto } = scanBackups(R);
    const plan = planRotation(auto, { keepPerFile: 3, keepDailyDays: KEEP_DAILY_DAYS, now: base });
    const keptDays = new Set(plan.keep.map((r) => new Date(r.mtime).toISOString().slice(0, 10)));
    ok(keptDays.size === 6, `6 天每天的最后一份都在保留名单里（实得 ${keptDays.size} 天）`);
    ok(plan.del.length < auto.length, `仍有删除（删 ${plan.del.length} / 共 ${auto.length}）`);
    fs.rmSync(R, { recursive: true, force: true });
  }
}
