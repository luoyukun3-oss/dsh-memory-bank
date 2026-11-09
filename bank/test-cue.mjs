// ============================================================================
// test-cue.mjs —— 第 26 节：触发式联想（2026-11-09 从 test.mjs 按域拆出）
//   为什么拆：同 test-arch（test.mjs 459/460 逼近红线）。
//   ⚠️ 全部用**构造数据**、不依赖真库内容 —— 真实知识页每天在长，拿真页做断言会变成
//      「每天变红的测试」。覆盖 6 件事：词长判据 / 命中与上限 / output 只认 cue 档 /
//      无关不触发 / 低置信与元页排除 / df 门两个方向。
//   ⚠️ 原代码用 `await import(...)`，改静态 import（理由同 test-arch.mjs 头注释）。
// ============================================================================
import { buildCueTable, matchCues, formatCueNote, cueWordOk } from './cue.mjs';
import { CUE_MAX_HITS } from './config-keys.mjs';

export function runCueTests({ ok }) {
  console.log('== 26. 触发式联想（cue：词 → 条目，不等主命中） ==');
  // 全部用**构造数据**（不依赖真库内容）：真实知识页每天都在长，拿真页做断言会变成"每天变红的测试"。
  // 覆盖 6 件事：词长判据 / 命中与上限 / output 只认 cue 档 / 无关不触发 / 低置信与元页排除 / df 门两个方向。
  // cue.mjs 改为文件顶部静态 import（见文件头说明）
  // CUE_MAX_HITS 改为文件顶部静态 import（别名 TEST 一并去掉）
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
  ok(matchCues(mtab, '常见词', 'prompt').length === CUE_MAX_HITS && matchCues(mtab, '常见词', 'output').length === 0,
    'weak 词在 prompt 模式照常触发、在 output 模式被挡（两档标准不同，别一刀切）');
}
