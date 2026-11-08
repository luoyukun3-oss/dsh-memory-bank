// 记忆银行改造验收测试
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureRepo, repoDir, reindexPage, search, recall, loadAliases, writeText, parseMeta, checkLineBudgets,
  scoreCandidate, INBOX_GATE, isNoise,
} from './bank.mjs';
import { runMechanismTests } from './test-mechanisms.mjs';
import { runHandoffTests } from './test-handoff.mjs';
import { runSlopeTests } from './test-slope.mjs';
import { runFragTests } from './test-frag.mjs';
import { runMoodTests } from './test-mood.mjs';   // 情绪系统 v2（2026-10-13，按域拆出：本文件行数预算 440）
import { runAssocTests } from './test-assoc.mjs';
import { runRelCueTests } from './test-rel.mjs';   // cue/rel 静默错误守护（2026-10-27，按域拆出）  // 联想扩散（2026-10-27，按域拆出）
import { findDreamPairs } from './dream.mjs';
import { auditPatchStatus } from './patch-status.mjs';
import { auditDegenerate } from './degenerate-audit.mjs';
import { detectGuardDegenerate } from './guard-degen-detect.mjs';
import { observeStalls } from './stall-detect.mjs';
import { auditDependencies } from './dep-audit.mjs';
import { runTranscriptTests } from './test-transcripts.mjs';
import { runFactKeyTests } from './test-factkey.mjs';   // 事实键（2026-11-02）   // 多根会话发现（2026-10-29 接线：文件早就在，只是没被 import 过）
import { runLessonsAuditTests } from './test-lessons-audit.mjs';   // 哑弹审计键错位（2026-11-08）
import { runHandoffThinTests } from './test-handoff-thin.mjs';     // handoff 空泛小结降级（2026-11-08）

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [!!] ${name}${extra ? '  -> ' + extra : ''}`); }
};

console.log('== 1. 元数据解析 ==');
const a = parseMeta('- 条目 <!-- i:5 s:user c:low x:2020-01-01 sup:被新版取代 -->');
ok(a.meta.importance === 5 && a.meta.source === 'user' && a.meta.confidence === 'low' && a.meta.expires === '2020-01-01', '抽取 i/s/c/x', JSON.stringify(a.meta));
ok(a.meta.supersededBy === '被新版取代', '抽取 sup（含空格值）', JSON.stringify(a.meta.supersededBy));
ok(!a.cleaned.includes('<!--'), '正文里的注释被剥掉');
const b = parseMeta('<!-- i:1-5 s:user|probe|infer c:high|mid|low x:YYYY-MM-DD -->');
ok(Object.keys(b.meta).length === 0, '白名单挡住说明行里的示例注释', JSON.stringify(b.meta));

console.log('== 2. 别名表 ==');
const real = repoDir('e-2');
const groups = loadAliases(real);
ok(groups.length >= 20, `加载 ${groups.length} 组别名`);
ok(groups.some((g) => g.some((w) => w.includes('卡顿'))), '含「卡顿」组');

console.log('== 3. 同义改写召回（改造前只有 0.14~0.29，被阈值静默） ==');
/**
 * ⚠️ 2026-09-15 教训：本节原先写成
 *     `ok(want.test(`${best.title} ${best.page}`))` —— 只断言「top-1 的**标题**里出现了关键词」。
 * 而别名组的标题**本身就是术语清单**（「页面卡顿 | 卡顿 | 卡 | 很卡…」）⇒ `/卡顿/` 必然匹配，
 * 于是**测试永远绿，哪怕 top-1 命中的只是字典而不是知识**。测试被被测对象骗过了。
 * 更糟的是它用 `search()` 断言，而真实链路走 `recall()`（带自命中过滤与阈值）——
 * 拿一个**不带过滤**的 API 去验**带过滤**的行为，等于没验。字典一静音，journal 立刻浮上来当 top-1。
 * 改法：走 recall；断言「命中/没命中**哪一页知识**」，而不是「词面有没有出现过」。
 */
const cases = [
  ['电脑变慢 界面发钝 风扇一直响', 'faults.md'],   // 别名表存在的理由：纯口语 → 卡顿结论
  ['上次改权限改成什么了', 'decisions.md'],
  ['循环次数不能填小数', 'lessons.md'],
  ['网页按钮点了没反应', 'faults.md'],
];
const TRACE = new Set(['aliases.md', 'inbox.md']);   // 字典 / 未提炼原料
for (const [q, wantPage] of cases) {
  const { hits } = recall(real, q, { k: 5 });
  const best = hits[0];
  ok(hits.length > 0, `「${q}」越过阈值有命中`, best ? `top=${best.score.toFixed(2)} ${best.page}` : '无命中');
  ok(!!best && !TRACE.has(best.page) && best.kind !== 'journal',
    `「${q}」top-1 不是字典/原料/流水`, best ? `${best.kind}/${best.page} ${best.score.toFixed(2)}` : '无命中');
  ok(hits.some((h) => h.page === wantPage), `「${q}」命中 ${wantPage}`,
    hits.map((h) => h.page).slice(0, 4).join(','));
}

console.log('== 3b. 元页静音：字典不能当答案，但显式问还得给 ==');
const noisy = search(real, '电脑变慢 界面发钝 风扇一直响', 10);
ok(!noisy.some((h) => h.page === 'aliases.md'), '默认不召回 aliases.md（字典不该跟知识抢位）');
const wantAlias = search(real, '别名表里有哪些组', 10);
ok(wantAlias.some((h) => h.page === 'aliases.md'), '显式问「别名表」时才召回 aliases.md');

console.log('== 3c. 痕迹页不许冒充记忆 ==');
const noInbox = recall(real, '电脑变慢 界面发钝 风扇一直响', { k: 10, minScore: 0 });
ok(!noInbox.hits.some((h) => h.page === 'inbox.md'),
  'inbox 里逐字写着这句口语的「任务书」被自命中过滤挡住',
  noInbox.hits.filter((h) => h.page === 'inbox.md').map((h) => h.score.toFixed(2)).join(','));

console.log('== 3d. 表格页按行切分（faults 是一行一个故障，不该当整块） ==');
const fDocs = JSON.parse(fs.readFileSync(path.join(real, 'index.json'), 'utf8')).docs.filter((d) => d.page === 'faults.md');
ok(fDocs.length >= 10, `faults.md 切成 ${fDocs.length} 条`, `最长 ${Math.max(...fDocs.map((d) => (d.tokens || []).length))} token`);
ok(fDocs.every((d) => !String(d.title).startsWith('|')), '条目标题取的是首格，不是整行表格');
runHandoffTests({ ok, real });   // 3d2/3d3/3e 节：跨会话交接（2026-09-22 拆到 test-handoff.mjs）
runSlopeTests({ ok });           // 第 20 节：复读斜坡判据（2026-09-22 拆到 test-slope.mjs）
runFragTests({ ok });            // 第 21 节：碎片复读判据（2026-10-08 拆到 test-frag.mjs）
runFactKeyTests({ ok });           // 第 23 节：事实键（2026-11-02 新增）

console.log('== 4. 归档页不在检索池 ==');
const arch = search(real, '权限预设 workspace-write danger-full-access', 10);
ok(!arch.some((h) => h.page === 'todos-archive.md'), `10 条结果里无 todos-archive`, arch.map((h) => h.page).slice(0, 5).join(','));

console.log('== 5. 新页可召回 ==');
for (const [q, page] of [
  ['昨天干了什么 近期事件', 'events.md'],
  ['为什么改回 danger-full-access 决策理由', 'decisions.md'],
  ['模糊搜索 别名表', 'aliases.md'],
]) {
  const hits = search(real, q, 6);
  ok(hits.some((h) => h.page === page), `「${q}」-> ${page}`, hits.slice(0, 3).map((h) => h.page).join(','));
}

console.log('== 6. 软遗忘 / 置信度（临时仓库，条目级切分） ==');
const t = repoDir('_test-mb');
fs.rmSync(t, { recursive: true, force: true });
ensureRepo('_test-mb', null);
writeText(path.join(t, 'pages', 'events.md'), ['# events', '', '## 测试节',
  '- 高置信条目 关键词阿尔法 <!-- i:3 s:user c:high -->',
  '- 低置信条目 关键词阿尔法 <!-- i:3 s:infer c:low -->',
  '- 已取代条目 关键词阿尔法 <!-- i:3 s:user c:high sup:新条目 -->',
  '- 过期条目 关键词阿尔法 <!-- i:3 s:user c:high x:2020-01-01 -->',
  '- 重要条目 关键词阿尔法 <!-- i:5 s:user c:high -->',
].join('\n') + '\n');
reindexPage(t, 'events.md');
const th = search(t, '关键词阿尔法', 10);
const tT = th.map((h) => h.title);
console.log('    命中：' + th.map((h) => `${h.title.slice(0, 5)}(${h.score.toFixed(3)})`).join(' , '));
ok(tT.some((x) => x.includes('高置信')) && tT.some((x) => x.includes('已取代')) && tT.some((x) => x.includes('重要')), '条目级切分生效（5 条各自成 doc）', `共 ${tT.length} 条`);
ok(!tT.some((x) => x.includes('低置信')), 'low 置信条目被排除');
const sup = th.find((h) => h.title.includes('已取代'));
const normal = th.find((h) => h.title.includes('高置信'));
ok(!!sup && !!normal && sup.score < normal.score, '已取代条目被降权', sup && normal ? `${sup.score.toFixed(3)} vs ${normal.score.toFixed(3)}` : '缺');
const exp = th.find((h) => h.title.includes('过期'));
ok(!!exp && !!normal && exp.score < normal.score, '过期条目被降权', exp && normal ? `${exp.score.toFixed(3)} vs ${normal.score.toFixed(3)}` : '缺');
const imp = th.find((h) => h.title.includes('重要'));
ok(!!imp && !!normal && imp.score > normal.score, 'importance=5 高于 =3', imp && normal ? `${imp.score.toFixed(3)} vs ${normal.score.toFixed(3)}` : '缺');
fs.rmSync(t, { recursive: true, force: true });

console.log('== 6b. 写入失败不能拖垮召回（2026-09-15 事故：DSH 0.8.2 的 hook 跑在受限沙箱） ==');
// 事故链条：`recall(..., touch:true)` 想写 access.json → EPERM 抛异常 → 冒泡到 hook 的
// try/catch → **整个 user-prompt 失败、out 为空、一条注入都发不出去**。
// 一个锦上添花的功能（复述效应）把主力功能（召回）拖垮了。
// 这里把 access.json 造成一个**目录**，让写入必然失败（EISDIR），验证召回照样能返回。
const accessPath = path.join(real, 'access.json');
const accessBak = fs.existsSync(accessPath) ? fs.readFileSync(accessPath) : null;
fs.rmSync(accessPath, { recursive: true, force: true });
fs.mkdirSync(accessPath);
let threw = null;
let gotHits = -1;
try {
  gotHits = recall(real, '电脑变慢 风扇一直响', { k: 3, touch: true, minScore: 0 }).hits.length;
} catch (e) { threw = e; }
ok(!threw, 'access.json 写不进去时 recall **不抛异常**', threw ? String(threw.message).slice(0, 70) : '');
ok(gotHits > 0, '而且照样返回召回结果（注入不会因此消失）', `hits=${gotHits}`);
fs.rmSync(accessPath, { recursive: true, force: true });
if (accessBak) fs.writeFileSync(accessPath, accessBak);

console.log('== 7. 复述效应（recency 按上次被检索算） ==');const t2 = repoDir('_test-mb2');
fs.rmSync(t2, { recursive: true, force: true });
ensureRepo('_test-mb2', null);
writeText(path.join(t2, 'pages', 'events.md'), '# events\n\n## 今天\n- 事件甲 关键词贝塔\n- 事件乙 关键词贝塔\n');
reindexPage(t2, 'events.md');
const idxF = path.join(t2, 'index.json');
const idx = JSON.parse(fs.readFileSync(idxF, 'utf8'));
const oldTs = new Date(Date.now() - 30 * 86400000).toISOString();
for (const d of idx.docs) d.updated = oldTs;
fs.writeFileSync(idxF, JSON.stringify(idx, null, 2));
const s1 = recall(t2, '关键词贝塔', { minScore: 0 }).hits.map((h) => h.score.toFixed(4));
recall(t2, '关键词贝塔', { minScore: 0, touch: true });
const s2 = recall(t2, '关键词贝塔', { minScore: 0 }).hits.map((h) => h.score.toFixed(4));
ok(fs.existsSync(path.join(t2, 'access.json')), 'access.json 已生成');
ok(parseFloat(s2[0]) > parseFloat(s1[0]), '被检索过后分数回升（复述效应）', `${s1.join(',')} -> ${s2.join(',')}`);
fs.rmSync(t2, { recursive: true, force: true });

console.log('== 8. reflect 改造（主题化 + 与 lessons 比对） ==');
const { reflect } = await import('./bank.mjs');
const r = reflect(real, { days: 7 });
console.log(`    主题 ${r.themes} 个｜教训候选 ${r.candidates} 条｜错误模式 ${r.errors} 种｜未完成 ${r.openEnds}｜线索 ${r.openClues}`);
const rText = fs.readFileSync(r.file, 'utf8');
const secOf = (n) => rText.split('## ').find((s) => s.startsWith(n)) || '';

// 第一节：主题必须来自**别名表**（人工核对的组名），不能是 tokenize 的二元组碎片
const sec1 = secOf('一、');
const aliasLabels = new Set(loadAliases(real).map((g) => g[0]));
const themeLabels = [...sec1.matchAll(/^- `([^`]+)` ×\d+$/gm)].map((m) => m[1]);
ok(themeLabels.length > 0, `第一节给出 ${themeLabels.length} 个主题`);
ok(themeLabels.every((t) => aliasLabels.has(t)), '主题全部来自别名表（不是分词碎片）',
  themeLabels.filter((t) => !aliasLabels.has(t)).join(','));
ok(!/有什|是什|请输|忆系|析一/.test(sec1), '第一节不再出现二元组碎片');

// 第三节：不能把**粘贴的代码**当成"纠正信号"
const sec3 = secOf('三、');
ok(!/int\(input|while True|print\(|Traceback|def /.test(sec3), '「纠正」段不再混进粘贴的代码',
  (sec3.match(/int\(input|while True|print\(|Traceback|def /) || [])[0] || '');

// 第五节：候选必须有判据（未记过的主题）或明确说"无"
const sec5 = secOf('五、');
ok(/（无：|\[ \]|\[x\]/.test(sec5), '第五节给出候选或明确的"无"', sec5.split('\n')[2] || '');

console.log('== 9. 评分与退场机制（i 分筛选 / prune 只移不删 / dry-run 不落笔） ==');
const { bootstrapText, listItems, archiveItems } = await import('./bank.mjs');
const boot = bootstrapText(real, { budget: 5000 });
ok(/故障速查·\d+\/\d+ 条（i≥4/.test(boot), '故障段标注了「按 i≥4 筛选」的口径',
  (boot.match(/故障速查·[^\n]*/) || [])[0] || '');
const fseg = (boot.split('【故障速查')[1] || '').split('\n【')[0];
ok(!/代理链路/.test(fseg), 'i=2 的条目已降级出注入（仍留在检索池）');
ok(/页面卡顿/.test(fseg), 'i=5 的条目留在注入');

const fPath = path.join(real, 'pages', 'faults.md');
const before = fs.readFileSync(fPath, 'utf8');
const aPath = path.join(real, 'pages', 'archive.md');
const archBefore = fs.existsSync(aPath) ? fs.readFileSync(aPath, 'utf8') : null;
const noHit = archiveItems(real, { page: 'faults.md', pattern: '绝不可能匹配的字符串zzz', apply: false });
ok(!noHit.moved.length, '无匹配时明说没有条目');
// ⚠️ pattern 别拿「具体条目标题」当样本 —— 那条一旦被 prune 移档，这里就**假红**
// （2026-09-17 踩：'会话日志解压' 那条已移进 archive.md，于是本条报失败）。
// 改用元数据标记 `i:5`：确定性、不含正则元字符、且数据怎么变都仍然成立。
const dry = archiveItems(real, { page: 'faults.md', pattern: 'i:5', apply: false });
ok(dry.moved.length >= 1, `dry-run 能正确定位条目（命中 ${dry.moved.length} 条）`);
ok(fs.readFileSync(fPath, 'utf8') === before, '**dry-run 识别到条目后仍不改文件**');
// 断言「归档页内容前后一致」，而不是「归档页不存在」—— 后者在 archive.md 已被创建后永远假红
ok((fs.existsSync(aPath) ? fs.readFileSync(aPath, 'utf8') : null) === archBefore, 'dry-run 不创建/不修改归档页');
ok(!archiveItems(real, { page: 'faults.md', apply: false }).moved.length, '缺 --match 时拒绝执行（防手滑）');

const items = listItems(real, { page: 'faults.md' });
const i5 = items.filter((x) => x.i === 5).length;
// 下限放宽到 10：条数会随 prune 变动（2026-09-17 从 19 → 13），写死会持续假红
ok(items.length >= 10 && i5 >= 3, `faults 共 ${items.length} 条，其中 i=5 有 ${i5} 条`);
ok(items.every((x) => x.title && !x.title.startsWith('|')), '条目标题取的是首格、不是整行');

console.log('== 10. sweep 体检（软限制 + 退役候选 + 按价值排序） ==');
const { sweepRepo } = await import('./bank.mjs');
const sw = sweepRepo(real, { apply: false });
ok(sw.injectChars > 0 && sw.injectChars <= sw.budget, `注入 ${sw.injectChars} / ${sw.budget} 字`, `余量 ${sw.headroom}`);
ok(sw.headroom > 0, `余量 ${sw.headroom} 字 > 0`);
ok(Array.isArray(sw.lowValue) && sw.lowValue.every((x) => x.i <= 2), `退役候选 ${sw.lowValue.length} 条，判据严格 i ≤ 2`);
ok(sw.pages.length >= 6, `扫了 ${sw.pages.length} 个知识页`);
ok(sw.pages.some((p) => p.chars > 0 && p.items > 0), '各页统计带体积与条目数');
const beforeSweep = fs.readFileSync(path.join(real, 'pages', 'todos.md'), 'utf8');
sweepRepo(real, { apply: false });
ok(fs.readFileSync(path.join(real, 'pages', 'todos.md'), 'utf8') === beforeSweep, 'sweep 不带 apply 时不动文件');

// 故障段必须按 i **降序**：截断只发生在段尾，低价值的必须先被牺牲（否则新加的条目最先丢）
const fseg2 = (bootstrapText(real, { budget: 8000 }).split('【故障速查')[1] || '').split('\n【')[0];
const frows = fseg2.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l) && !/症状/.test(l));
const at5 = frows.findIndex((l) => /页面卡顿/.test(l));          // i=5
const at4 = frows.findIndex((l) => /按钮点了一点反应/.test(l));   // i=4
// 注：这条断言其实兼作「注入健康哨兵」—— 故障段配额有限，若高价值条目写得过长，
// 会把 i=4 挤出去 ⇒ 它变红时先想「是不是我塞太满了 / 条目该精简了」，而不是改断言。
ok(at5 >= 0 && at4 > at5, '故障段按 i 降序（i=5 排在 i=4 之前）', `i5@${at5} i4@${at4} 共${frows.length}条`);

console.log('== 11. 投递门：界面回填文本不该进 inbox（2026-09-18） ==');
// 起因：dsh-todo-panel 的面板点条目会回填「继续做这条待办：<标题>」，措辞完整得像一条真待办，
// 基础分 0.65 稳稳越过 0.5 的门 —— 实测每点一次面板就抓一条进 inbox。本节守住两头：
// 「挡得住回填」，也「不误伤真待办」。
const FILL_TEXT = '继续做这条待办：侧栏待办面板（已装好，只差重启验证）';
ok(scoreCandidate(FILL_TEXT) < INBOX_GATE, '面板回填文本被挡在投递门外', `score=${scoreCandidate(FILL_TEXT)}`);
ok(scoreCandidate('  ' + FILL_TEXT) < INBOX_GATE, '带前导空格的回填同样挡住', `score=${scoreCandidate('  ' + FILL_TEXT)}`);
const REAL_TODO_TEXT = '明年 7–8 月备齐学历材料，9 月上旬网报';
ok(scoreCandidate(REAL_TODO_TEXT) >= INBOX_GATE, '真·待办陈述不受影响（不误伤）', `score=${scoreCandidate(REAL_TODO_TEXT)}`);
// —— 2026-10-10 追加：定时派发文本（与面板回填同一病根的另一形态，⑦ 没挡住）——
const SCHED_TEXT = '【定时待办】② 录制环境 关通知、窗口 1600×900、演示数据备好（≥4 条待办＋1 条定时）；录前 F5 让面板取快照 （来自待办文件的定时条目，由 dsh-todo-panel 自动派发；规则：10月5日 16:29（一次性））';
ok(scoreCandidate(SCHED_TEXT) < INBOX_GATE, '定时派发文本被挡在投递门外', `score=${scoreCandidate(SCHED_TEXT)}`);
ok(scoreCandidate('  ' + SCHED_TEXT) < INBOX_GATE, '带前导空格的定时派发同样挡住', `score=${scoreCandidate('  ' + SCHED_TEXT)}`);

console.log('== 12. 架构红线：行数预算（借自 dsh-pet，红了即失败） ==');
// dsh-pet 的做法：架构约束**由测试守护**而不靠人自觉（它给 window.py 设 4429 行预算）。
// 预算表在 bank/budgets.json；原则「只许瘦不许胖：超限先按域拆分，不靠压缩行宽硬塞」。
const memRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // bank/ → _dsh_memory/
const bud = checkLineBudgets(memRoot);
ok(bud.rows.length >= 5, `预算表覆盖 ${bud.rows.length} 个文件`);
for (const row of bud.rows) {
  ok(
    !row.missing && !row.over,
    `${row.file} 在预算内（${row.lines ?? '缺失'} / ${row.budget}）`,
    row.missing ? '文件不存在' : `超限 ${row.lines - row.budget} 行 —— 先按域拆分，别压缩行宽`,
  );
}

console.log('== 13. 外挂补丁 / 防护插件自检 ==');
const ps = auditPatchStatus();
// ⚠️ 断言必须**在"空清单"下也成立** —— 2026-09-19 两条内核补丁退役后 items 为空，
//    原先那句 `ps.items[0].state` 直接抛 TypeError 把整个测试文件打崩了。
ok(ps.items.every((it) => ['applied', 'missing', 'unknown', 'notfound', 'unreadable'].includes(it.state)), `在册补丁状态取值已知（在册 ${ps.items.length} 条，retired 不计入）`);
ok(ps.items.every((it) => it.state !== 'unknown'), '在册补丁的锚点仍能唯一命中（对不上 ⇒ 上游源码已变，须人工复核）');
ok(ps.plugins.length >= 1 && ps.plugins.every((g) => g.mounted !== false), `防护插件都已挂进 profile bundles（${ps.plugins.length} 个）`);
const dg = auditDegenerate(real);
ok(dg.hits.every((h) => h.kind === 'degenerate' || h.kind === 'interrupted'), '退化审计每条都带 kind 分类（流中断 ≠ 推理退化，别开错处方）');
// 第四类（2026-10-12）：被 empty-response-guard 拦下的退化在**流层**就被改写成 error 去重试，
// 那次调用不写 assistant/message ⇒ 上面 dg.hits 必然 0 条（实测当天 11 条全漏）。必须单独统计。
ok(dg.guard && typeof dg.guard.count === 'number' && Array.isArray(dg.guard.hits), 'guard 拦下的退化被单独统计（老判据扫 assistant/message，看不见它）');
const gmk = (kind, code, texts) => ({
  type: 'assistant/attempt', time: 1,
  data: { turn: 1, step: 1, stream: [
    { chunk: { type: 'usage', usage: { totalTokens: 182580, inputTokens: 169, cacheReadTokens: 181376 } } },
    { chunk: { type: 'reasoning-chunks', index: 0, texts } },
    { chunk: { type: 'finish', reason: kind === 'stop' ? { kind: 'stop' } : { kind: 'error', failure: { code } } } },
  ] },
});
const gTexts = ['思考', '只想了没说'];
const ghit = detectGuardDegenerate([gmk('error', 'EMPTY_RESPONSE', gTexts)]);
ok(ghit.count === 1 && ghit.hits[0].reasonChars === gTexts.join('').length && ghit.hits[0].ctxTokens === 182580, 'guard 判据：EMPTY_RESPONSE 计入条数，思考字数取 reasoning-chunks.texts，ctx 取 totalTokens（不是 inputTokens）');
ok(detectGuardDegenerate([gmk('stop', '', ['正文'])]).count === 0, '正常 stop 不被误报成 guard 拦下的退化');
ok(detectGuardDegenerate([gmk('error', 'TRANSPORT', [])]).count === 0, '流中断（TRANSPORT）不混进退化（两者处方相反）');

console.log('== 14. 连续停滞判据（零依赖复刻自 thinking-loop-guard 的 LoopDetector） ==');
// 生成"高熵"文本：每个 4-gram 都不同 ⇒ repeatRatio≈0、跨步 containment≈0，这样测的才是**停滞累积**逻辑，
// 而不是误触 low-entropy/repeated-material 分支。实测该复刻在真实历史上与插件本体逐字一致
// （21 个会话里只有 7343d6e6 触发 1 次：t44/1:reasoning-only，起于 t42/1）。
const ut = (tag, n = 400) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
const mk = (hasOutput, tag) => ({ turn: 1, step: 1, hasOutput, reasoning: ut(tag) });
ok(observeStalls([mk(false, 'a'), mk(false, 'b'), mk(false, 'c')]).fireCount === 1, '连续 3 步无可见产出 ⇒ 触发一次');
const shortStep = { turn: 1, step: 1, hasOutput: true, reasoning: '短' };
ok(observeStalls([mk(false, 'a'), mk(false, 'b'), shortStep]).fireCount === 0
  && observeStalls([mk(false, 'a'), mk(false, 'b'), shortStep, mk(false, 'd')]).fireCount === 1,
  '短步骤既不计入也不清零（上游行为，自己实现时最容易写成清零）');
ok(observeStalls([mk(false, 'a'), mk(false, 'b'), mk(true, 'c'), mk(false, 'd'), mk(false, 'e')]).fireCount === 0,
  '中间一步真进展（有正文且不复读）⇒ 计数清零');

console.log('== 15. 做梦（找「无共享标签、却共享罕见词」的条目对） ==');
const dr = findDreamPairs(real, { limit: 5 });
ok(dr.total > 0 && dr.rareWords > 0, `扫了 ${dr.total} 条、罕见词 ${dr.rareWords} 个`);
ok(dr.candidates.every((c) => c.a !== c.b && c.shared >= 3), '每组都是两个不同条目、且至少共享 3 个罕见词');
ok(dr.candidates.every((c) => c.words.every((w) => !isNoise(w))), '罕见词里没有数字/停用词（isNoise 真的生效了）');
ok(dr.hubs.every((h) => h.degree >= 8), `枢纽页的度都 ≥ 阈值（本次排出 ${dr.hubs.length} 个）`);

console.log('== 16. 零依赖红线（借自 dsh-pet：架构约束由测试守护） ==');
// 起因：hook 跑在 DSH 受限沙箱里，第三方依赖一旦缺失就**静默失败**（注入消失比报错难查得多）；
// 同时本轮把测试自身 `file:///E:/2/...` 的硬编码 import 改成相对路径 ⇒ 换目录不再自崩。
const dep = auditDependencies();
ok(dep.files >= 10, `扫了 ${dep.files} 个模块`);
ok(dep.violations.length === 0, '没有第三方依赖 / 绝对路径 import',
  dep.violations.map((v) => `${v.file}:${v.line} → ${v.spec}`).join('; '));
ok(dep.specifiers.every((s) => s.kind === 'builtin' || s.kind === 'relative'),
  `${dep.specifiers.length} 个依赖说明符全部合规（node: 内建 or 相对路径）`);

console.log('== 17. 配置键三处同步（借 dsh-pet：新增键必须登记，值不许再写一遍） ==');
// 起因是实测到的漂移：MIN_SCORE 于 2026-09-17 由 1.2 上调 1.5，可是 recall-eval 抄了一份
// 靠行尾注释人肉对齐、bank.mjs 两处注释至今仍写着 1.2 —— 纸面约定（注释）挡不住漂移。
// dsh-pet 的解法是「默认值 + 白名单 + 测试快照」三处登记，这里等价成「登记表 + 消费点 + 文档一致」。
const ck = await import('./config-keys.mjs');
const consumers = Object.entries(ck.CONSUMERS);
ok(consumers.length >= 3, `登记表覆盖 ${consumers.length} 个配置键（值只在 config-keys.mjs 定义）`);
const missRef = [];
for (const [key, files] of consumers) {
  for (const f of files) {
    const src = fs.readFileSync(path.join(memRoot, f), 'utf8');
    if (!new RegExp(`\\b${key}\\b`).test(src)) missRef.push(`${f} 里找不到 ${key}`);
  }
}
ok(missRef.length === 0, '声明的消费点都真的引用了登记表（没退回硬编码）', missRef.join('; '));
// 文档漂移是这类问题最常见的形态：文档里写的数字必须等于代码里的值
const todoHead = fs.readFileSync(path.join(real, 'pages', 'todos.md'), 'utf8');
const docBudget = Number((todoHead.match(/总预算\s*(\d+)\s*字/) || [])[1]);
ok(docBudget === ck.INJECT_BUDGET, `todos.md 头写的总预算与登记表一致（文档 ${docBudget} / 代码 ${ck.INJECT_BUDGET}）`);
// 2026-10-13 实测踩到：往 note 里插了一个半角双引号 ⇒ budgets.json 解析失败 ⇒ 而 `readJson(..., {}).budgets || {}`
// **静默退化成「0 个文件」**，行数红线整条失效却不报错（当时唯一信号是断言总数 261→192）。这里专门盯它。
let bj = {}; try { bj = JSON.parse(fs.readFileSync(path.join(memRoot, 'bank', 'budgets.json'), 'utf8')).budgets || {}; } catch { bj = {}; }
ok(Object.keys(bj).length > 0, `budgets.json 能解析出 budgets 表（${Object.keys(bj).length} 项）—— 它坏掉会让行数红线**静默**失效`);

console.log('== 26. 触发式联想（cue：词 → 条目，不等主命中） ==');
// 全部用**构造数据**（不依赖真库内容）：真实知识页每天都在长，拿真页做断言会变成"每天变红的测试"。
// 覆盖 6 件事：词长判据 / 命中与上限 / output 只认 cue 档 / 无关不触发 / 低置信与元页排除 / df 门两个方向。
const { buildCueTable, matchCues, formatCueNote, cueWordOk } = await import('./cue.mjs');
const { CUE_MAX_HITS: CUE_MAX_HITS_TEST } = await import('./config-keys.mjs');
const mkDoc = (id, page, title, text, meta = {}, tokens = []) => ({ id, page, kind: 'page', title, text, meta, tokens });
ok(cueWordOk('乱码') && !cueWordOk('乱') && !cueWordOk('乱 码') && !cueWordOk('1234'),
  '触发词判据：≥2 字、无空白/标点、非纯数字');
const cdocs = [
  mkDoc('lessons.md#1', 'lessons.md', '编码坑', '看到乱码先查编码', { cues: ['乱码', 'GBK'], importance: 4 }),
  mkDoc('lessons.md#2', 'lessons.md', '另一条编码坑', '乱码与 BOM', { cues: ['乱码'] }),
  mkDoc('faults.md#1', 'faults.md', '卡顿', '性能问题', { tags: ['性能'] }),
  mkDoc('decisions.md#1', 'decisions.md', '某决策', '乱码', { cues: ['乱码'], confidence: 'low' }),
];
const ctab = buildCueTable(cdocs);
const ch = matchCues(ctab, '这段输出是乱码', 'prompt');
ok(ch.length === 2 && ch.every((h) => h.level === 'cue'), '命中触发词，且最多 2 条');
ok(!matchCues(ctab, '这段输出是乱码', 'output').some((h) => h.level === 'tag'),
  'output 模式（工具输出）只认 cue 档 —— 海量文本里泛词会漫天误触发');
ok(matchCues(ctab, '我们聊点别的', 'prompt').length === 0, '无关文本不触发（保持安静）');
ok(!JSON.stringify(matchCues(ctab, '乱码', 'prompt')).includes('decisions.md'), 'confidence=low 的条目不参与联想');
ok(!Object.keys(buildCueTable([mkDoc('handoff.md#0', 'handoff.md', '交接', 'x', { cues: ['乱码'] })]).words).length
  && !Object.keys(buildCueTable([mkDoc('inbox.md#0', 'inbox.md', '原料', 'x', { cues: ['乱码'] })]).words).length,
  '元页（handoff）/ 原料页（inbox）不参与联想');
const note = formatCueNote(matchCues(ctab, '乱码', 'prompt'));
ok(note.startsWith('（联想触发 · 看到「乱码」）'), '注入段开头写明"因为看到哪个词"');
ok((note.match(/看到「乱码」/g) || []).length === 1, '同一个词只报一次（两条记忆由同一词带出时）');
ok(formatCueNote([]) === '', '无命中返回空串（安静退出，不注入废话）');
// df 门（2026-10-13 拿真库标定：泛词当触发词会让装置每轮都触发）—— 两个方向都要测，只测一边等于没测
const wide = Array.from({ length: 30 }, (_, i) => mkDoc(`w.md#${i}`, 'w.md', '泛词条目', '泛词', { tags: ['泛词'] }, ['泛词']));
ok(Object.keys(buildCueTable(wide).words).length === 0, 'df 门：30/30 条都含的词（t: 标签）不当触发词');
const narrow = [...wide, mkDoc('w.md#z', 'w.md', '冷门条目', '冷门', { tags: ['冷门'] }, ['冷门'])];
ok(!!buildCueTable(narrow).words['冷门'], 'df 门：31 条里只有 1 条含的词照常当触发词');
// 2026-10-29 推翻 10-13 的「人工标注 ⇒ 免检 df 门」：体检实测「实测」df 23.4%、却只挂 1 条
// ⇒ scoreCueHits 归一化后 p=1.00，独占唯一的 CUE_BODY_HITS 正文名额 ⇒ **每轮无条件注入同一条
// 无关记忆**（日常句误报 1/8，且 100% 来自「环境」）。人工标注 ≠ 不会写出泛词。
// 现在 cue 与 tag 同门；df < 8% 的「环境/静默/rev」本门挡不住，靠删页面标注处理。
ok(!buildCueTable([mkDoc('a.md#1', 'a.md', '人工标注', 'x', { cues: ['泛词'] }, ['泛词'])]).words['泛词'],
  'cue: 也过 df 门（10-13 的「人工标注免检」已被 10-29 实测推翻）');
// `+` = 空格：报错原文才是最好的触发词（「看到 has not been read 就想起那条」比"看到 write"精确得多），
// 可注释按空白切分 ⇒ 只能这样写。这条判据不测就会在某次重构里静默失效（词表里多出一个带 + 的怪词）。
ok(!!buildCueTable([mkDoc('a.md#2', 'a.md', '原文', 'x', { cues: ['has+not+been+read'] })]).words['has not been read'],
  'cue: 里的 `+` 还原成空格（报错原文当触发词）');
// output 词筛（2026-10-13 回放标定：不加这道门，工具输出命中率 55% ⇒ write/hook/window 这类词淹掉上下文）
// ⚠️ 构造必须落在 (CUE_DF_MAX_OUTPUT 5%, CUE_DF_MAX 8%) 的**交集区间**：低于 5% 不标 weak，
// 高于 8% 会被 cue 档的门直接挡掉（2026-10-29 起 cue 也过门）⇒ 8/120 = 6.67% 两边都测得到，
// 且命中数必须 = CUE_MAX_HITS(8) 才测得出「截断」这一步。
const mixDocs = [
  ...Array.from({ length: 8 }, (_, i) => mkDoc(`m.md#${i}`, 'm.md', '常见词条目', '常见词', { cues: ['常见词'] })),
  ...Array.from({ length: 112 }, (_, i) => mkDoc(`m.md#x${i}`, 'm.md', '冷门条目', '冷门内容')),
];
const mtab = buildCueTable(mixDocs);
ok(mtab.weak?.['常见词'] === true, 'output 词筛：库内 df 高于 CUE_DF_MAX_OUTPUT 的词被标 weak');
ok(matchCues(mtab, '常见词', 'prompt').length === CUE_MAX_HITS_TEST && matchCues(mtab, '常见词', 'output').length === 0,
  'weak 词在 prompt 模式照常触发、在 output 模式被挡（两档标准不同，别一刀切）');

runRelCueTests({ ok, real });   // 第 21b 节：cue/rel 的静默错误守护（2026-10-27 拆到 test-rel.mjs，本文件预算 440 行）

runMechanismTests({ ok, real, memRoot });   // 第 18 / 19 节已按域拆到 test-mechanisms.mjs（2026-09-21）
runMoodTests({ ok, real, memRoot });        // 第 20 节：情绪系统 v2（2026-10-13，按域拆到 test-mood.mjs）
runAssocTests({ ok, real });                // 第 21 节：联想扩散的不变量（2026-10-27，assoc.mjs 改成扩散式）
runTranscriptTests({ ok });                  // 第 22 节：findTranscripts 多根合并（2026-10-29 接线，此前是孤儿测试）
runLessonsAuditTests({ ok });                // 第 27 节：哑弹审计的键口径（2026-11-08 修 192 条假阳性）
runHandoffThinTests({ ok });                 // 第 3g 节：handoff 空泛小结降级（2026-11-08）
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);

process.exitCode = fail ? 1 : 0;

// 2026-10-05 事故后补的回归：TOC 注入机制（目录幂等 / 行号一致 / 只出目录+定时 / 无 TOC 回退 / splitItems 遇 --- 不归属条目）
import './test-toc.mjs';
