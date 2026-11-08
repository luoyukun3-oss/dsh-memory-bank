// 教训哑弹审计的验收测试（2026-11-08）—— 按域拆出，与 test-mood / test-factkey 同例。
//
// 为什么必须有这个文件：2026-11-07 上线的 `lessons-audit.mjs` 有**整套判据错位**的 bug，
// 而它当时**一条断言都没有**（test.mjs 里 grep 不到 auditLessons）—— 于是「192 条哑弹候选」
// 被当成真数据写进待办，差点直接拿去批量退役。
//
// 守什么（每条都能证伪）：
//   ① **键口径**：审计查 access 用的 id 必须是 index.json 的 doc id（条目序号），
//      **不是文件行号** —— 这条是 bug 本体，钉死它。
//   ② **构造一个「有命中」和「无命中」的对照**：有命中的不许进候选（防假阳性方向的另一面：
//      防「什么都报哑弹」）。
//   ③ **观察期**：新写的条目（不足 N 天）不参与 —— 宁漏勿杀。
//   ④ **无日期条目跳过**：算不出年龄就不判死。
//   ⑤ **报告里带行号**（给人看/prune 用），但判定不依赖它。
import fs from 'node:fs';
import path from 'node:path';
import { ensureRepo, repoDir, reindexPage, writeText, bumpAccess } from './bank.mjs';
import { auditLessons, formatDormantReport, DORMANT_DAYS } from './lessons-audit.mjs';

export function runLessonsAuditTests({ ok }) {
  console.log('== 27. 教训哑弹审计（lessons-audit，2026-11-08 修键错位） ==');
  const t = repoDir('_test-la');
  fs.rmSync(t, { recursive: true, force: true });
  ensureRepo('_test-la', null);

  // 造 4 条：两条老（一活一哑）、一条新、一条无日期。
  // ⚠️ 故意让「文件行号」与「条目序号」错开：前面塞 3 行表头/空行，第 4 行才是第一条 bullet。
  const lines = [
    '# lessons',
    '',
    '> 表头注释，不是条目',
    '- 2026-01-01 **哑弹甲：这条永不被召回** 关键词赞塔',
    '- 2026-01-02 **活条目乙：这条被 touch 过** 关键词伊塔',
    '- ' + new Date().toISOString().slice(0, 10) + ' **新条目丙：还在观察期** 关键词西塔',
    '- **无日期条目丁：算不出年龄** 关键词奥米克',
  ];
  writeText(path.join(t, 'pages', 'lessons.md'), lines.join('\n') + '\n');
  reindexPage(t, 'lessons.md');

  // 只给「乙」打命中记录 —— 用 index 的 doc id，与真实链路（recall touch）同源
  const idx = JSON.parse(fs.readFileSync(path.join(t, 'index.json'), 'utf8'));
  const docB = idx.docs.find((d) => String(d.text).includes('活条目乙'));
  ok(!!docB, '测试夹具：找到「活条目乙」的 doc', docB ? docB.id : '未找到');
  ok(/^lessons\.md#\d+$/.test(docB.id), '① access 键是「页#条目序号」格式（不是行号）', docB.id);
  bumpAccess(t, [docB.id]);

  // 把「乙」的命中时间改到书写之后，模拟「写成后被召回」
  const accPath = path.join(t, 'access.json');
  const acc = JSON.parse(fs.readFileSync(accPath, 'utf8'));
  acc[docB.id] = Date.now();
  fs.writeFileSync(accPath, JSON.stringify(acc), 'utf8');

  const r = auditLessons(t, { days: DORMANT_DAYS });

  ok(r.total === 4, '③ 条目总数按 index 的 doc 数算（=4，不是文件行数）', String(r.total));

  const ids = r.dormant.map((d) => d.id);
  ok(ids.length === 1, '② 只有「哑弹甲」进候选（乙有命中、丙在观察期、丁无日期）', JSON.stringify(ids));

  const jia = r.dormant[0];
  ok(jia && String(jia.title).includes('哑弹甲'), '② 候选正是「哑弹甲」', jia ? jia.title : '空');
  ok(jia && jia.n > 0, '⑤ 报告里带出源文件行号（给人看/prune 用）', jia ? 'L' + jia.n : '无');
  ok(jia && jia.n === 4, '⑤ 行号定位准确（第 4 行是它，前面 3 行是表头）', jia ? 'L' + jia.n : '无');

  ok(!ids.includes(docB.id), '② 「活条目乙」有命中 ⇒ 不进候选（防假阳性）', docB.id);
  ok(r.dormant.every((d) => !String(d.title).includes('无日期')), '④ 无日期条目不出现在候选里');
  ok(r.counted === 2, '③ 观察期外可判的只有 2 条（甲、乙）', String(r.counted));

  // 回归铁证：旧实现会把「行号」当键 ⇒ 行号 4 的条目本来无键，但旧代码查的正是 #4。
  // 现在候选 id 必须是 doc id（lessons.md#2，因为表头占了 #0/#1），而不是 lessons.md#4。
  ok(jia.id !== 'lessons.md#4', '★① bug 本体：候选 id 不是文件行号 #4（旧实现正是这样错位的）', jia.id);

  const report = formatDormantReport(r, { days: DORMANT_DAYS }).join('\n');
  ok(report.includes('index.json 的 lessons 条目'), '报告写明口径（防止再被当成行号）');
  ok(!report.includes('✅'), '有候选时不给「全清」的假信号');

  fs.rmSync(t, { recursive: true, force: true });
}
