// ============================================================================
// test-index-guard.mjs —— 第 35 节：索引写后自检（2026-11-08）
//
// 守两件事（抄自 LivingMemory，但判据按我们的域重定）：
//   ① **回读比对**：写进去的必须能读回来、条数一致（原子写 + 回读双保险）
//   ② **条数突变告警**：单次写入改掉 ±30% 以上就记一条 `state/index-alerts.json`
//
// 为什么阈值是 30%（不是拍的）：
//   正常增删是"加几条 / 删几条"；而真实事故是
//     · `index.json` docs **2288 → 1056（-54%）**
//     · `journal/` 重复段清理 **-50% 量级**
//   真事故都远超 30%，所以 30% 不会误报日常操作。
//   下限 `prev >= 20` 避开「空库首次建索引」这种从 0 到 N 的正常增长。
//
// ⚠️ 回读比对那支属**防御性代码**：原子写（`writeJson` = tmp + rename）保证它几乎不可能触发，
//   正常路径测不到。这里用「写入后外部篡改」的等价手段覆盖不到同步窗口，
//   所以只断言"正常路径不误报"，并在注释里如实标注它未被单测覆盖 —— 不假装测过了。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitIndex, indexCount, readIndexAlerts, hasIndexAlerts, SHIFT_ALERT_RATIO } from './index-guard.mjs';

/** 造一个带 n 条 docs 的临时库。 */
function bankWith(n) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-idxguard-'));
  const docs = Array.from({ length: n }, (_, i) => ({ id: `p.md#${i}`, page: 'p.md', title: `t${i}`, text: `x${i}` }));
  fs.writeFileSync(path.join(T, 'index.json'), JSON.stringify({ docs, updatedAt: 'old' }), 'utf8');
  return { T, docs };
}

const mkDocs = (n) => Array.from({ length: n }, (_, i) => ({ id: `p.md#${i}`, page: 'p.md', title: `t${i}`, text: `x${i}` }));

export function runIndexGuardTests({ ok }) {
  console.log('== 35. 索引写后自检：回读比对 + 条数突变告警（2026-11-08，真缩水过 -54%） ==');

  // ① 正常增量：不告警
  {
    const { T } = bankWith(100);
    const n = commitIndex(T, { docs: mkDocs(105), updatedAt: 'new' });
    ok(n === 105, `写入条数返回正确（${n}）`);
    ok(indexCount(T) === 105, '回读条数与写入一致');
    ok(!hasIndexAlerts(T), '正常增量（+5%）**不**产生告警');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ② 大幅缩水 ⇒ 告警（复刻 2288→1056 的形态）
  {
    const { T } = bankWith(100);
    commitIndex(T, { docs: mkDocs(46), updatedAt: 'new' });   // -54%
    ok(hasIndexAlerts(T), '缩水 54% ⇒ 产生告警文件');
    const items = readIndexAlerts(T);
    ok(items.length === 1, `告警条数 1（实得 ${items.length}）`);
    ok(items[0] && items[0].before === 100 && items[0].after === 46, '告警里记了 before/after 真实数字');
    ok(items[0] && items[0].pct === -54, `告警里记了百分比（实得 ${items[0]?.pct}）`);
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ③ 大幅膨胀也告警（不只防缩水）
  {
    const { T } = bankWith(100);
    commitIndex(T, { docs: mkDocs(300), updatedAt: 'new' });
    ok(hasIndexAlerts(T), '膨胀 200% ⇒ 也告警（双向都盯）');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ④ 首次建库（prev < 20）不误报
  {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-idxguard-'));
    fs.writeFileSync(path.join(T, 'index.json'), JSON.stringify({ docs: [] }), 'utf8');
    commitIndex(T, { docs: mkDocs(200), updatedAt: 'new' });
    ok(!hasIndexAlerts(T), '从 0 条建到 200 条**不**告警（下限 20 条以内不判）');
    ok(indexCount(T) === 200, '首次建库后条数正确');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ⑤ 阈值本身可核对（防止有人悄悄改成 0.01 让每天的增删都告警）
  {
    ok(SHIFT_ALERT_RATIO === 0.3, `突变阈值是 0.3（实得 ${SHIFT_ALERT_RATIO}）—— 与真实事故的量级对齐`);
  }

  // ⑥ 告警文件只留最近 50 条（别让「记录告警」自己变成大文件）
  //    ⚠️ 这一段会循环触发几十次告警，把 stderr 刷屏 —— 临时静音，否则测试输出没法看。
  {
    const { T } = bankWith(100);
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      for (let i = 0; i < 60; i++) commitIndex(T, { docs: mkDocs(i % 2 ? 100 : 20), updatedAt: 'x' });
    } finally {
      process.stderr.write = origWrite;   // 必须还原，否则后面所有测试的 stderr 都哑了
    }
    const items = readIndexAlerts(T, 1000);
    ok(items.length <= 50, `告警最多留 50 条（实得 ${items.length}）`);
    fs.rmSync(T, { recursive: true, force: true });
  }
}
