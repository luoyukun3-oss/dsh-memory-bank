// ============================================================================
// Memory Bank · reflect —— 从 bank.mjs 拆出（2026-09-22）
//   ⚠️ 本文件**不许 import bank.mjs**（那会循环依赖）；只依赖 node 标准库 + ./core.mjs + 同层模块。
// ============================================================================
import { clip, day, lineToText, loadAliases, nowIso, readJson, readText, writeJson, writeText, zh } from './core.mjs';
import { renderNegSection, scanNegFeedback } from './reflect-neg.mjs';
import { openClues } from './reflect-clues.mjs';          // 未闭环事项（2026-11-09 按域拆出）
import { lessonCandidates } from './reflect-cand.mjs';   // 教训候选（2026-11-09 按域拆出）
import { pushNegToInbox } from './neg-inbox.mjs';
import path from 'node:path';
import fs from 'node:fs';






export function reflect(dir, { days = 7 } = {}) {
  const jdir = path.join(dir, 'journal');
  const files = fs.existsSync(jdir) ? fs.readdirSync(jdir).filter((f) => f.endsWith('.md')).sort() : [];
  const raw = files.map((f) => readText(path.join(jdir, f))).join('\n');
  // 2026-09-15 修复：按**行内时间戳**取最近 N 天，而不是按文件名切最后 N 个文件。
  // 原因：`ingest --full` 重建后一个会话的流水会集中在「会话起始日」那个文件里，
  // 按文件名切片会把它当最旧、直接漏掉最新内容（这是我上一处改动引入的副作用）。
  const cutoff = Date.now() - days * 86400000;
  const text = raw
    .split('\n')
    .filter((l) => {
      const m = l.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/);
      if (!m) return false;
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .join('\n');
  const userTexts = text.split('\n').filter((l) => l.includes('**[用户]**')).map(lineToText).filter((s) => s.length > 1);

  // 一、主题分布（2026-09-15 重做）
  // 原先直接统计 `tokenize` 出来的**二元组词频**，于是「高频话题」输出的是
  // `有什` ×9 / `是什` ×8 / `请输` ×7 这类**分词碎片** —— 零信息量（它们只是"什么东西"、
  // "请输入"被切开的残渣），而真正在折腾的主题反而看不出来。更糟的是第五节「教训候选」
  // 只是**同一堆碎片的子集**，两节一起变成噪声。
  // 改用**别名表的 45 组**当主题词表（那是人工核对过的口语↔术语对照）：
  // 一组命中用户的消息就算该主题一次 ⇒ 输出「卡顿/性能 ×5」这种**看得懂的主题**。
  const groups = loadAliases(dir);
  const themeHits = new Map();
  for (const g of groups) {
    const label = g[0];
    let n = 0;
    for (const t of userTexts) {
      const low = t.toLowerCase();
      if (g.some((w) => w && low.includes(w))) n++;
    }
    if (n) themeHits.set(label, n);
  }
  const themes = [...themeHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  // 二、错误模式
  const errRe = /(Traceback|SyntaxError|TypeError|ValueError|NameError|IndexError|KeyError|AttributeError|IndentationError|ZeroDivisionError|UnboundLocalError|EPERM|Access is denied)/g;
  const errs = new Map();
  for (const m of text.matchAll(errRe)) errs.set(m[1], (errs.get(m[1]) || 0) + 1);

  // 三、纠正/追问（2026-09-15 修）：原先只按关键词抓，于是把**粘贴的代码**当成了"纠正信号"
  // —— 代码里含「输入的不是整数」这种字样就中招（实测抓进来的全是 `y=int(input(...))` 整段）。
  // 补两层过滤：**像代码的**（ASCII 括号/等号/分号、def/print/while 等）与**过长的**都排除。
  const CODEISH = /[=(){}[\];]|\bdef\b|\bprint\b|\bwhile\b|\bfor\b|\bint\(|\bimport\b|Traceback/;
  const corrections = userTexts
    .filter((l) => /不是|错了|不对|应该是|为什么|搞错/.test(l))
    .filter((l) => l.length <= 120 && !CODEISH.test(l))
    .slice(-8);

  // 三之二、负面反馈候选（2026-10-28）：逻辑在 ./reflect-neg.mjs —— 本文件行数预算已逼近，
  // 按「超限先按域拆分」的规矩单独立模块。这里只取结果，落盘渲染同样交给它。
  const negCandidates = scanNegFeedback(userTexts);

  // 四、未闭环事项（2026-11-09 按域拆出 → ./reflect-clues.mjs，判据与注释随代码一起搬走）
  //   ① 权威清单 = `pages/todos.md` 未勾选项 ② 线索 = 用户原话关键词命中（已排除"已完成"信号与已归档重复项）
  const { todoOpen, openEndClues } = openClues(dir, userTexts);

  // 五、教训候选（2026-11-09 按域拆出 → ./reflect-cand.mjs：判据、阈值标定、勾选沿用都随代码搬走）
  const { candidates, coveredThemes, doneTokens } = lessonCandidates(dir, themes);

  const out = [];
  out.push(`# 深度反思 ${day()}（最近 ${days} 天内 · ${userTexts.length} 条用户消息 · ${files.length} 个流水文件）`);
  out.push('');
  out.push(`> 生成时间：${zh()}｜依据：${userTexts.length} 条用户消息｜自动生成（启发式），供模型进一步深化`);
  out.push('');
  out.push('## 一、主题分布（最近在折腾什么）');
  out.push('');
  out.push('> 主题词取自 `pages/aliases.md` 的别名组（人工核对过的口语↔术语），不再是分词碎片。');
  out.push('');
  if (themes.length) for (const [t, c] of themes) out.push(`- \`${t}\` ×${c}`);
  else out.push('（最近没有可识别的主题）');
  out.push('');
  out.push('## 二、错误模式（反复踩的坑）');
  out.push('');
  if (errs.size) for (const [e, c] of [...errs.entries()].sort((a, b) => b[1] - a[1])) out.push(`- **${e}** ×${c}`);
  else out.push('（最近没有捕获到报错）');
  out.push('');
  out.push('## 三、用户纠正/追问（理解偏差的信号）');
  out.push('');
  if (corrections.length) for (const c of corrections) out.push(`- ${clip(c, 160)}`); else out.push('（无）');
  out.push('');
  out.push('## 四、未闭环事项');
  out.push('');
  if (todoOpen.length) {
    out.push('**① 来自 `pages/todos.md` 的未完成项（权威清单）**');
    for (const t of todoOpen) out.push(`- ${t}`);
  } else {
    out.push('**① `pages/todos.md` 里没有未完成项**');
  }
  out.push('');
  if (openEndClues.length) {
    out.push('**② 用户话里的线索（关键词命中，已排除"已完成/搞定"等信号与已归档事项；仍可能误报，供参考）**');
    for (const c of openEndClues) out.push(`- ${clip(c, 160)}`);
  } else {
    out.push('**② 用户话里没有明显的新线索**');
  }
  out.push('');
  out.push('## 五、教训候选（主题活跃，但 `lessons.md` 里没有显著相关的条目）');
  out.push('');
  if (candidates.length) {
    for (const [t, c, near] of candidates) {
      out.push(`- [${doneTokens.has(t) ? 'x' : ' '}] \`${t}\`（出现 ${c} 次）— 最接近：${near}`);
    }
    out.push('');
    out.push('> 处理过的候选请把 `[ ]` 改成 `[x]` —— 下次反思会沿用勾选状态，不再重复提醒。');
    out.push('> 「最接近」是检索到的最近条目与分数；若它其实已经讲清楚了，说明**只是说法不同**（判据是词法近似），勾掉即可。');
  } else {
    out.push('（无：最近活跃的主题都已在 `lessons.md` 记过）');
  }
  if (coveredThemes.length) out.push(`> 已记过（无需重复固化）：${coveredThemes.join('、')}`);
  out.push('');
  out.push(...renderNegSection(negCandidates));
  // 纠错自动进箱（2026-11-07，借 dsh-tacit「零点击候选」思路）：逻辑在 ./neg-inbox.mjs。
  // 自动只管「进箱」，晋升仍由助手审箱人工判断 —— 与 ingest 投箱同一条铁律。
  const negInbox = pushNegToInbox(dir, negCandidates);
  out.push(`> 本轮自动进箱 ${negInbox} 条（纠正原话 → inbox.md，待审）。`);
  out.push('## 七、给下一步的行动建议');
  out.push('');
  out.push('- 就「教训候选」逐条判断，确认成立的写进 `pages/lessons.md`（可让助手在会话里深化）');
  out.push('- 逐条看「负面反馈候选」，成立且没记过的落 `inbox.md`');
  out.push('- 检查「未闭环事项」，已解决的从 `pages/todos.md` 划掉');
  out.push('- 高频错误补一条"预防写法"到 `pages/lessons.md`');
  out.push('');

  const rf = path.join(dir, 'reflections', `${day()}.md`);
  writeText(rf, out.join('\n'));
  const lm = readJson(path.join(dir, 'bank.json'), {});
  lm.lastReflectAt = nowIso();
  writeJson(path.join(dir, 'bank.json'), lm);
  return { file: rf, themes: themes.length, candidates: candidates.length, errors: errs.size, openEnds: todoOpen.length, openClues: openEndClues.length, negCandidates: negCandidates.length, negInbox };
}
