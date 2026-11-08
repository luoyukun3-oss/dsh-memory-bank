// 情绪系统 v2 的验收测试（2026-10-13）—— 按域拆出，与 test-handoff / test-slope / test-frag / test-mechanisms 同例。
// 拆出的直接原因：test.mjs 撞了行数红线（budgets.json 的架构红线，只许瘦不许胖）。
//
// 这里盯的是**权限表**（decisions.md:8）能不能被绕过：
//   ① 联想加权 ≤ **当前档位**的上限（`MOOD_WEIGHTS`；默认档的值就是 MOOD_BOOST_MAX），且**只进 rank 不进 score**（事实通道权重恒为 0）；
//   ② 写气氛必须有证据、改口必须有理由（否则拒写）；
//   ③ `mood.json` 在 pages/ 之外 ⇒ recall **搜不到情绪**（物理隔离，不是靠自觉）；
//   ④ hook 的注入触发只认 score ⇒ 情绪永远无法把条目顶过 INJECT_MIN_SCORE；
//   ⑤ **审计层不许复活**（2026-10-13 用户指出：那份统计采样的是用户自己的话，对象错了 ⇒ 删）。
import fs from 'node:fs';
import path from 'node:path';
import { ensureRepo, repoDir, reindexPage, search, recall, writeText, bootstrapText } from './bank.mjs';
import * as moodMod from './mood.mjs';
import {
  clearMood, currentMoodWeight, formatMoodNote, formatMoodReport, loadMood, moodBoost,
  moodSnapshot, parseThemes, setMood, setMoodWeight,
} from './mood.mjs';
import {
  MOOD_BOOST_MAX, MOOD_DANGER_LEVELS, MOOD_WEIGHTS, MOOD_WEIGHT_DEFAULT, MOOD_WEIGHT_NAMES,
  moodBoostMax, moodBudget, parseMoodWeight,
} from './config-keys.mjs';

export function runMoodTests({ ok, real, memRoot }) {
  console.log('== 20. 情绪系统 v2（mood，2026-10-13） ==');
  const mt = repoDir('_test-mood');
  fs.rmSync(mt, { recursive: true, force: true });
  ensureRepo('_test-mood', null);
  writeText(path.join(mt, 'pages', 'lessons.md'),
    ['# lessons', '', '- 情绪隔离测试条目 关键词西格玛 <!-- i:3 s:user c:high -->'].join('\n') + '\n');
  reindexPage(mt, 'lessons.md');

  // —— 机制①：没有证据就没有情绪
  let t1 = null;
  try { setMood(mt, { label: '平静' }); } catch (e) { t1 = e.message; }
  ok(!!t1 && /evidence/.test(t1), '写入气氛必须带 --evidence（机制①：情绪不许瞎猜）', t1 || '没抛错');
  const s1 = setMood(mt, { label: '专注', tone: '轻松', themes: '阿尔法, 贝塔、伽马', evidence: '主人：示例原话（2026-10-13）', intensity: 1, source: 'user' });
  ok(s1.mood.current.label === '专注' && s1.mood.history.length === 1, '写入成功且历史留档');
  ok(parseThemes('a, b、c c').join('|') === 'a|b|c', '主题清洗：逗号/顿号/空格都算分隔、自动去重');
  // —— 机制②：改口留痕
  let t2 = null;
  try { setMood(mt, { label: '被催', evidence: '主人：示例原话（2026-10-13）' }); } catch (e) { t2 = e.message; }
  ok(!!t2 && /reason/.test(t2), '气氛 label 变化必须带 --reason（机制②：改口留痕）', t2 || '没抛错');
  const s2 = setMood(mt, { label: '被催', evidence: '主人：示例原话（2026-10-13）', reason: '测试改口' });
  ok(s2.mood.history[0].from === '专注' && s2.mood.history[0].reason === '测试改口', '改口在历史里留下 from → to + reason');
  let t3 = null;
  try { clearMood(mt, {}); } catch (e) { t3 = e.message; }
  ok(!!t3, 'clear 也要 --reason（同一把尺子）');

  // —— 隔离性：mood.json 在 pages/ 之外 ⇒ recall 永远搜不到情绪
  setMood(mt, { label: '贝塔气氛', evidence: '主人：示例原话（2026-10-13）', reason: '测试隔离', themes: '西格玛' });
  const mh = recall(mt, '贝塔气氛 被催 专注', { minScore: 0, k: 10 });
  ok(!mh.hits.some((h) => /贝塔气氛|被催/.test(`${h.title || ''}${h.text || ''}`)),
    'recall 搜不到情绪（物理隔离：mood.json 不在 pages/ 里）', mh.hits.map((h) => h.page).join(',') || '零命中');

  // —— 加成：封顶 + 只认主题命中 + 只进 rank 不进 score
  const full = moodBoost({ title: '情绪系统 破甲 记忆系统', text: '', meta: {} },
    { current: { intensity: 1, themes: ['情绪系统', '破甲', '记忆系统'] } });
  ok(full <= MOOD_BOOST_MAX + 1e-9, `加成封顶（实测 ${full.toFixed(4)} ≤ ${MOOD_BOOST_MAX}）`);
  ok(moodBoost({ title: '无关内容', text: '', meta: {} }, { current: { intensity: 1, themes: ['西格玛'] } }) === 0,
    '主题不命中 ⇒ 加成为 0（不会因情绪捞无关条目）');
  ok(moodBoost({ title: '西格玛', text: '', meta: {} }, null) === 0, '没有气氛 ⇒ 加成为 0');
  const mw = search(mt, '关键词西格玛', 10).find((h) => /西格玛/.test(h.title || ''));
  ok(!!mw && mw.moodBoost > 0 && Math.abs(mw.rank - (mw.score + mw.moodBoost)) < 1e-9,
    '命中主题 ⇒ rank = score + moodBoost（排序偏置）', mw ? `${mw.score.toFixed(3)} + ${mw.moodBoost}` : '缺');
  clearMood(mt, { reason: '测试结束，清空' });
  const mn = search(mt, '关键词西格玛', 10).find((h) => /西格玛/.test(h.title || ''));
  ok(!!mn && !!mw && Math.abs(mn.score - mw.score) < 1e-9, '同一条目：有无气氛时 **score 完全相同**（事实通道权重恒 0）',
    mw && mn ? `${mw.score.toFixed(4)} vs ${mn.score.toFixed(4)}` : '缺');
  ok(mn && mn.rank === undefined, '无气氛 ⇒ 不设 rank（零开销，不进排序分支）');

  // —— 注入段：没气氛就不占预算；有气氛则排在事实段之后
  ok(formatMoodNote(loadMood(mt)) === '', '没有气氛 ⇒ 注入段是空串（不占预算）');
  setMood(mt, { label: '专注', tone: '轻松', themes: '西格玛', evidence: '主人：示例原话（2026-10-13）', reason: '测试注入' });
  const note = formatMoodNote(loadMood(mt));
  ok(/不参与事实判断/.test(note) && /证据/.test(note), '气氛段自带边界声明与证据（不是干巴巴一个标签）');
  const boot = bootstrapText(mt, { budget: 8000 });
  ok(boot.includes('【当前气氛】'), '开场注入带上【当前气氛】段');
  ok(boot.indexOf('【当前气氛】') > boot.indexOf('【教训索引'),
    '注入顺序：**事实段（教训索引）排在情绪段之前**',
    `教训@${boot.indexOf('【教训索引')} 气氛@${boot.indexOf('【当前气氛】')}`);

  // —— 权重档位（2026-10-13 晚新增：用户要的「只要一个情绪权重，低/中/高几个选项」）
  //    盯三件事：① 档位表本身合法；② 可读写、认中文、乱输入**拒写**；
  //    ③ **★ 守线：换档位时 score 一个字都不许变**，且 off 档＝真的关掉。
  const weights = Object.entries(MOOD_WEIGHTS);
  ok(weights.length >= 3 && MOOD_WEIGHT_DEFAULT in MOOD_WEIGHTS,
    `档位表有 ${weights.length} 档且默认档存在（${MOOD_WEIGHT_DEFAULT}）`);
  ok(weights.every(([, v]) => v.boost >= 0 && v.budget >= 0)
    && MOOD_WEIGHTS.off.boost === 0 && MOOD_WEIGHTS.off.budget === 0,
    '每档 boost/budget 非负，且 off 档＝真正归零（关掉情绪，不是"调得很小"）');
  // ⚠️ 2026-10-15 修：原断言是 `every(v => v.boost <= 0.5)`，而 2026-10-13 深夜用户点名的
  //    **危险档（danger 0.60 / extreme 1.00）故意破了这个 0.5** —— 于是它自那天起**恒红**，
  //    而红的原因写在 config-keys 的注释里、跟断言本身没关系 ⇒ 一条长期假红会把整张表变噪声。
  //    改法：**给危险档开口子，其余档位仍守 0.5**（把"破例"写成可执行的白名单，而不是删断言）。
  //    ⚠️ 别把它放宽成"全都不限"：0.5 仍是普通档的天花板，那是"情绪只该影响先想起谁"的量化线。
  const CEILING = 0.5;
  const overCeiling = weights.filter(([k, v]) => v.boost > CEILING && !MOOD_DANGER_LEVELS.includes(k));
  ok(overCeiling.length === 0,
    `普通档加成上限 ≤ ${CEILING}（危险档 ${MOOD_DANGER_LEVELS.join('/')} 是主人点名的破例，另计）`,
    overCeiling.map(([k, v]) => `${k}=${v.boost}`).join(', '));
  ok(MOOD_DANGER_LEVELS.every((k) => k in MOOD_WEIGHTS),
    '破例白名单里的档位都真实存在于档位表（防止白名单写出一个不存在的档 ⇒ 悄悄放行别的）');
  ok(parseMoodWeight('高') === 'high' && parseMoodWeight('关') === 'off'
    && parseMoodWeight('瞎写') === MOOD_WEIGHT_DEFAULT,
    '档位认中文（高/关），认不出的退默认档（不抛错 ⇒ 配置坏了不拖垮记忆银行）');
  ok(moodBoostMax('high') > moodBoostMax('mid') && moodBoostMax('mid') > moodBoostMax('low'),
    '档位序：high > mid > low', `${moodBoostMax('high')} > ${moodBoostMax('mid')} > ${moodBoostMax('low')}`);

  const w0 = currentMoodWeight(mt);
  ok(w0 === MOOD_WEIGHT_DEFAULT, `没有配置文件时用默认档「${MOOD_WEIGHT_NAMES[w0]}」`);
  const wr = setMoodWeight(mt, 'high');
  ok(wr.config.weight === 'high' && currentMoodWeight(mt) === 'high', '档位能写能读回（high）');
  ok(fs.existsSync(path.join(mt, 'mood-config.json')),
    '档位存**独立文件** mood-config.json（不混进会被 set/clear 反复重写的 mood.json）');
  let t4 = null;
  try { setMoodWeight(mt, '乱写一个'); } catch (e) { t4 = e.message; }
  ok(!!t4 && /认不出/.test(t4), '乱输入**拒写**（不像读那样退默认 —— 手滑要当场看见）', t4 || '没抛错');

  // ★ 守线：换档位只动 rank，score 一个字都不许变
  const atHigh = search(mt, '关键词西格玛', 10).find((h) => /西格玛/.test(h.title || ''));
  setMoodWeight(mt, 'low');
  const atLow = search(mt, '关键词西格玛', 10).find((h) => /西格玛/.test(h.title || ''));
  ok(!!atHigh && !!atLow && Math.abs(atHigh.score - atLow.score) < 1e-9,
    '★ high 与 low 档下 **score 完全相同**（档位只动排序，事实通道恒不受影响）',
    atHigh && atLow ? `${atHigh.score.toFixed(4)} vs ${atLow.score.toFixed(4)}` : '缺');
  ok(!!atHigh && !!atLow && atHigh.moodBoost > atLow.moodBoost,
    '档位确实在起作用：high 的排序加成 > low（否则这旋钮是假的）',
    atHigh && atLow ? `${atHigh.moodBoost} vs ${atLow.moodBoost}` : '缺');
  ok(moodBudget('off') === 0 && formatMoodNote(loadMood(mt), 'off') === '',
    'off 档 ⇒ 连气氛注入段都不生成（关就是真关）');
  // 用中档测显示（低档配额只有 120 字，档位行会被 cutText 截掉 —— 那是配额设计的正常结果，
  // 所以 tone 行里档位**故意排在证据之前**，只不过 120 字连前两行都快装满）。
  const dump = formatMoodNote(loadMood(mt), 'mid');
  ok(/权重档位/.test(dump), '气氛段里带上当前档位（看得见才好调）');
  // ★ 报告显示的档位必须**真的等于**配置档位 —— 防「漏传 level ⇒ 静默按默认档渲染」（本轮真踩过：
  //   commands/mood.mjs 的 show 分支漏传，用户设成「高」时 CLI 照样打印「中」，而旧断言全绿）。
  setMoodWeight(mt, 'high');
  ok(/高（high）/.test(formatMoodReport(loadMood(mt), currentMoodWeight(mt))),
    '★ CLI 报告里的档位 = 配置档位（漏传 level 会静默显示默认档）');
  const snap = moodSnapshot(mt);
  ok(snap.weight.level === 'high' && snap.weight.boostMax === moodBoostMax('high')
    && snap.weights.length >= 3 && snap.current && snap.current.label === '专注',
    'moodSnapshot 是界面/工具用的只读快照（当前档位 + 全部档位表 + 当前气氛）',
    JSON.stringify(snap.weight));
  ok(snap.weights.filter((s) => s.default).length === 1,
    '快照里默认档有且只有一个标记（面板画单选钮要用它）');
  setMoodWeight(mt, MOOD_WEIGHT_DEFAULT);

  // —— ⑤ 审计层不许复活（它扫的是用户自己的话，2026-10-13 用户指出后删掉）
  ok(!('auditMoodPressure' in moodMod) && !('isPressureTurn' in moodMod) && !('PRESSURE_WORDS' in moodMod),
    '审计层已移除：不再导出压力词表 / 审计函数（别偷偷加回来）',
    Object.keys(moodMod).filter((k) => /pressure|retract|audit/i.test(k)).join(',') || '干净');

  // —— 真库：机制层合规 + hook 侧源码守护
  const rm = loadMood(real);
  ok(rm.history.every((h) => h.evidence), '真库 mood 历史每条都带证据');
  ok(rm.history.every((h) => !h.from || h.from === h.label || h.reason), '真库 mood 每次改口都留了理由');
  const up = fs.readFileSync(path.join(memRoot, 'bank', 'hooks', 'user-prompt.mjs'), 'utf8');
  ok(/h\.score >= MIN_SCORE/.test(up) && !/moodBoost|\brank\b/.test(up),
    'hook 注入触发只认 score（情绪不得绕过 INJECT_MIN_SCORE）');

  fs.rmSync(mt, { recursive: true, force: true });
}
