// ============================================================================
// Memory Bank · bootstrap —— 从 bank.mjs 拆出（2026-09-22）
//   ⚠️ 本文件**不许 import bank.mjs**（那会循环依赖）；只依赖 node 标准库 + ./core.mjs + 同层模块。
// ============================================================================
import { GLOBAL_SLUG, ROOT, clip, cutText, pageBlocks, parseMeta, readJson, readText, repoDir, stripFirstHeading, zh } from './core.mjs';
import { pendingLine } from './watch.mjs';
import { HANDOFF_CHARS, INJECT_BUDGET, moodBudget } from './config-keys.mjs';
import { recall } from './search.mjs';
import { currentMoodWeight, formatMoodNote, loadMood } from './mood.mjs';
import { formatInboxBrief } from './dream-inbox.mjs';   // 联想收件箱（2026-10-18）
import { formatMemoBrief } from './commands/memo.mjs';   // 备忘录（2026-10-18）
import path from 'node:path';
import fs from 'node:fs';
import { tocInject, indexList, lessonIndex } from './inject-index.mjs';
export { indexList, lessonIndex };                 // 索引进注入（2026-10-05 按域拆出）


export function bootstrapText(dir, { budget = INJECT_BUDGET } = {}) {
  const meta = readJson(path.join(dir, 'bank.json'), {});
  const pages = path.join(dir, 'pages');
  const parts = [];
  const ref = (name) => path.join(pages, name);

  // 1) 全局偏好（跨仓库）：结构化保留
  // 2026-10-31 用户要求「硬约束一定要保证全注入」⇒ **取消 2000 字上限**，整段原样进注入。
  //   理由：硬约束若被 cutText 按行切成半条，比没有更糟（看着有条规则、实际后半句没了）。
  //   代价：这一段的字数直接进总预算（见下方 SEG_BUDGET 里同一段的注释）；它排在最前，
  //   总预算吃紧时被挤掉的是**后面那些段**，不是它。
  const gpref = readText(path.join(repoDir(GLOBAL_SLUG), 'pages', 'preferences.md'));
  if (gpref.trim()) parts.push('【全局偏好】\n' + stripFirstHeading(gpref).trim());

  // 2) 本仓库待办：索引式（每条一行、自动跳过已完成项）
  const todoIdx = indexList(readText(ref('todos.md')));
  if (todoIdx.trim()) {
    parts.push('【本仓库待办·索引】（`[x]` 已完成项已自动略过）\n' + todoIdx + `\n→ 细节全文：${ref('todos.md')}`);
  }

  // 2.2) 待整理队列（2026-09-17 新增）：inbox 非空时**必须让模型看见**。
  //      背景：`inbox.md` 已在打分阶段**彻底退出召回**（见 search() 里的 continue），
  //      所以"不主动提示"就等于**把它藏起来了** —— 而「要不要晋升」的裁决权在模型，
  //      模型看不见就无从裁决。这正是 Ariadne「把要不要记交给模型」在本地架构下的落点：
  //      入口不做判断（HEUR 自动抓、允许误抓）→ **晋升由模型判断**。
  //      空时不 push，一分预算都不占。
  const inboxN = pageBlocks(readText(path.join(pages, 'inbox.md')).split('\n')).length;
  if (inboxN > 0) {
    parts.push(`【待整理队列】inbox.md 有 ${inboxN} 条**未经验证**的候选 —— 它们**不进召回**（防污染），所以你不主动看就永远不会知道。请你在会话里判断后**晋升进知识页或删掉**。\n→ 读它：${ref('inbox.md')}`);
  }

  // 2.2b) 联想收件箱（2026-10-18 用户拍板方案 A：「用收件箱，定时拉子代理审批」）。
  //      背景：`tick` 里的 ⑦ 做梦段**早就在后台每 30 分钟跑**（计划任务 DSH-Memory-Bank-Save），
  //      但候选只 echo 进 `state/bank_tick.log` —— 那个文件被 `>` 每次覆盖、还是 GBK 乱码
  //      ⇒ **产出没人吃**（10-18 实测：还在报 56 组，却从没人审过）。本段把「待审条数」
  //      送到眼前。空箱返回 '' ⇒ 一分预算都不占（与 inbox / watch / mood 段同策略）。
  const diBrief = formatInboxBrief(dir);
  if (diBrief) parts.push(diBrief);

  // 2.2c) 助手内务（2026-10-18 用户拍板「需要一个你用的待办」）：与用户的 todos.md 物理分开。
  //       空队列返回 '' ⇒ 一分预算都不占（与 inbox / watch / mood / 联想收件箱 同策略）。
  const memoBrief = formatMemoBrief(dir);
  if (memoBrief) parts.push(memoBrief);

  // 2.3) 外部回复·未读（2026-09-30 新增）：治"人工盯不可靠"。
  //      起因：2026-09-28 21:36 对方在 issue 里回了我们，**直到 09-29 下午才被用户告知**。
  //      做法：`cli watch check` 把"上次数到几条"落进 `_dsh_memory/watch.json`，
  //      这里**纯读本地文件、零网络**，有未读才 push（没有就一分预算都不占）。
  const wl = pendingLine(ROOT);
  if (wl) {
    parts.push(`【外部回复·未读】${wl}\n→ 看完清：\`cli watch read <owner/repo> <number>\`；查新回复：\`cli watch check\``);
  }

  // 2.4) 跨会话交接（2026-09-22 落地，用户拍板保留 5 轮）：答「**上次聊到哪、什么状态**」。
  //      与 2.5【近期事件】的分工：事件段是**事件粒度**（昨天干了什么），本段是**轮次粒度**
  //      （最后几轮你我各说了什么）⇒ 互补、不重复。
  //      数据由 `cli tick` 写（agent 侧有写权限；hook 在只读沙箱写不了，见 faults.md），
  //      本函数**只读** —— 所以 SessionStart hook 一行都不用改，开场自动带上。
  //      文件不存在就不 push：首次使用（还没跑过带 handoff 的 tick）不占一分预算。
  const hoText = readText(ref('handoff.md'));
  if (hoText.trim()) {
    // ⚠️ HANDOFF_CHARS 的口径是**渲染出来的那一整段**（含段标题与 `→ 详情` 行，见 config-keys.mjs）。
    //    2026-10-10 实测：只按「轮次正文 ≤ HANDOFF_CHARS」生成时整段最长到 **633**（头尾壳约 140 字没算进去）
    //    ⇒ 壳长必须在这里先扣掉，否则预算只管住了 3/4。另留 20 字给 cutText 的截断标记
    //    （`\n…（已截断，完整内容见对应文件）` 实长 17，且**它是加在 n 之上的** ⇒ 不预留就会超出）。
    const hoHead = '【上次聊到哪·最后几轮】（跨会话交接，`tick` 自动滚动更新）\n';
    const hoFoot = `\n→ 详情：${ref('handoff.md')}`;
    const hoBody = cutText(stripFirstHeading(hoText), Math.max(120, HANDOFF_CHARS - hoHead.length - hoFoot.length - 20));
    if (hoBody.trim()) parts.push(hoHead + hoBody + hoFoot);
  }

  // 2.5) 近期事件（2026-09-15 新增）：补上注入里「近期事件 0%」的洞 ——
  //      原注入只有待办 / 故障 / 教训这类**通用规则**，新会话不知道「昨天干了什么」。
  const evText = readText(ref('events.md'));
  if (evText.trim()) {
    // 2026-09-17 改「叙述式」：原先一行一条、每条 140 字硬截，而连续几条**都以 `[下午]` 开头**
    // —— 时间重复四次、读起来像清单不像回忆。用户当天提的判断「故事化应该更连续」在 events
    // 这一段是成立的（注入主体仍该是列表，只有这一段该像回忆）。改法：按日期分组、组内用
    // ①②③ 串起来，日期只出现一次，时序感保留。
    let curDate = '';
    const evItems = [];
    for (const l of stripFirstHeading(evText).split('\n')) {
      const h = l.match(/^##+\s+(\S+)/);
      if (h) { curDate = h[1]; continue; }
      if (!/^\s*[-*]\s+\S/.test(l) || /^\s*[-*]\s*\[[ xX]\]/.test(l)) continue;
      const raw = parseMeta(l).cleaned.replace(/^\s*[-*]\s+/, '');
      const t = raw.length > 140 ? raw.slice(0, 140) + '…' : raw;   // 截断要带省略号（clip 不带）
      if (t) evItems.push({ date: curDate, text: t });
    }
    const last = evItems.slice(-4);
    if (last.length) {
      const byDate = new Map();
      for (const it of last) {
        if (!byDate.has(it.date)) byDate.set(it.date, []);
        byDate.get(it.date).push(it.text);
      }
      const NUM = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
      const body = [...byDate.entries()].map(([d, arr]) => {
        // 相邻条目若同属一个时段（`[傍晚]`…），只保留第一个 —— 否则时间词重复三遍，
        // 正是"像清单不像回忆"的病根之一。
        let prevSlot = '';
        const parts2 = arr.map((t, i) => {
          const m = t.match(/^\[([^\]]+)\]\s*/);
          if (m) {
            if (m[1] === prevSlot) t = t.slice(m[0].length);
            else prevSlot = m[1];
          }
          return `${NUM[i] || '·'} ${t}`;
        });
        return (d ? `${d}：` : '') + parts2.join('  ');
      }).join('\n');
      parts.push('【近期事件】（帮你接上「昨天干了什么」）\n' + body
        + '\n（事件行里的情绪只用于语气共情，**不参与事实判断**）'
        + `\n→ 全部：${ref('events.md')}`);
    }
  }

  // 2.6) 重要决策（2026-09-15 新增）：**带理由的决策**最值钱 —— 只挑重要度 i>=4 的
  const decText = readText(ref('decisions.md'));
  if (decText.trim()) {
    const rows = stripFirstHeading(decText)
      .split('\n')
      .map((l) => ({ l, p: parseMeta(l) }))
      .filter((x) => /^\s*[-*]\s+\S/.test(x.l) && (x.p.meta.importance || 3) >= 4)
      .map((x) => clip(x.p.cleaned.replace(/^\s*[-*]\s+/, ''), 130))
      .slice(0, 3);
    if (rows.length) {
      parts.push('【重要决策·带理由】\n'
        + rows.map((r) => `- ${r}`).join('\n') + `\n→ 全部：${ref('decisions.md')}`);
    }
  }

  // 3) 故障速查·三层（2026-09-15，用户要求「重要的留着、之后不会再问的降级」）：
  //    ① 大索引 = 条数概览 ② 小索引 = **i ≥ 4** 的条目 ③ 细节 = `page faults.md`
  //    原先按**文件顺序取前 5 行** —— 那是"谁排在文件前面谁进注入"，跟"用户还会不会问"毫无关系。
  //    改按 `i:` 评分筛：用户高频的（页面卡顿 / 解释器被拒 / Python 找不到库）留在注入；
  //    我们自己踩的实现坑（patch entry、hook exitCode、多帧 zstd…）降到 i ≤ 3 ——
  //    **仍然留在检索池里可被召回**，只是不再白占注入预算。这就是「降级」而非「删除」。
  const faults = readText(ref('faults.md'));
  if (faults.trim()) {
    const flines = stripFirstHeading(faults)
      .split('\n')
      .filter((l) => l.trim() && !/^\s*>/.test(l) && !/^#{1,6}\s/.test(l) && !/^<!--/.test(l.trim()));
    const sepIdx = flines.findIndex((l) => /^\s*\|[\s:|-]+\|\s*$/.test(l));
    const fhead = sepIdx >= 0 ? flines.slice(0, sepIdx + 1) : [];
    const fdata = flines.slice(sepIdx + 1).filter((l) => /^\s*\|/.test(l));
    // 按 i **降序**排（同 i 保持原顺序）：截断只会发生在段尾，所以必须让高价值的排在前面，
    // 否则新加的条目（总在表格末尾）会第一个被切掉 —— 那等于"越新的越容易被牺牲"。
    const fkept = fdata
      .map((l, idx) => ({ l, i: parseMeta(l).meta.importance || 3, idx }))
      .filter((x) => x.i >= 4)
      .sort((a, b) => b.i - a.i || a.idx - b.idx)
      .map((x) => x.l);
    // 三层贯彻到底（2026-09-15 二次瘦身）：注入**只给行动线索**「症状 → 先查哪里」，
    // 那列「结论 / 处理」最长（每条 90 字，7 条就是 630 字），恰恰最适合按需 recall。
    // 依据：hook 召回已修复（此前它一直被 EPERM 拖垮），细节不必再常驻注入。
    const oneLine = (l) => {
      const clean = parseMeta(l).cleaned || l;
      const cells = clean.split('|');
      if (cells.length < 4) return clean;
      return `| ${cells[1].trim()} | ${cells[2].trim()} |`;
    };
    const rows = [...fhead, ...fkept].map(oneLine).join('\n');
    if (rows.trim()) {
      // 2026-11-05 用户拍板方案(c)：标题分子 = **段配额内实际渲染的行数**，而非通过筛选的条数。
      //   旧口径写 16/50，但段配额 800 字只能装下约 9 行 ⇒ 读者误以为全部高价值条目都在注入里。
      //   算法：用 capSeg 相同的口径预截一次（故障段配额 800，见下方 SEG_BUDGET），数出真正留下的数据行。
      const FAULT_SEG_BUDGET = 800;
      const fsegTitle = `【故障速查·${fkept.length}/${fdata.length} 条（i≥4，其余按需召回）】`;
      const preview = cutText(fsegTitle + '\n' + rows, FAULT_SEG_BUDGET);
      const shown = preview.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l) && !/症状/.test(l)).length;
      parts.push(`【故障速查·${shown}/${fdata.length} 条（i≥4，其余按需召回）】\n${rows}\n→ 全量：${ref('faults.md')}`);
    }
  }

  // 3.6) 程序记忆（2026-09-17 新增，参 subconscious-skill 的「程序记忆」）：从"做过什么"里提取
  //      「**该怎么做**」。与 lessons 的分工：lessons 记"错在哪"（过去），本页记"招式"（现在/将来）。
  //      取法**按 ## 分组、每组取前 2 条** —— 而不是取"最新 N 条"，否则只会拿到第一组、丢了别的主题。
  const procText = readText(ref('procedures.md'));
  if (procText.trim()) {
    let curSec = '';
    const bySec = new Map();
    for (const l of stripFirstHeading(procText).split('\n')) {
      const h = l.match(/^##+\s+(.+?)\s*$/);
      if (h) { curSec = h[1]; continue; }
      if (!/^\s*[-*]\s+(?!\[)/.test(l)) continue;
      const txt = clip(parseMeta(l).cleaned.replace(/^\s*[-*]\s+/, ''), 150);
      if (!txt) continue;
      if (!bySec.has(curSec)) bySec.set(curSec, []);
      if (bySec.get(curSec).length < 2) bySec.get(curSec).push(txt);
    }
    const rows = [...bySec.entries()].map(([s, arr]) => `**${s}**：${arr.join(' ／ ')}`);
    if (rows.length) {
      parts.push('【程序记忆·该怎么做】（lessons 记"错在哪"，这里记"招式"；全量用 `page procedures.md`）\n'
        + rows.map((r) => `- ${r}`).join('\n'));
    }
  }
  // 4) 教训索引·三层（2026-09-15 重做）：大索引（类名 + 条数）+ 小索引（每类最近 3 条），
  //    具体数据不进注入、靠 `page lessons.md` / `recall` 按需取。
  //    原先每类展开 14~15 条共 1749 字，占注入 36%、把预算顶到 4971/5000 ——
  //    **新教训反而挤不进注入**。上限从 1800 降到 1100（实测约 700 字），余量留给知识和事件。
  const lessons = readText(ref('lessons.md'));
  if (lessons.trim()) {
    const li = lessonIndex(lessons);
    if (li.trim()) parts.push('【教训索引·目录→按需取】\n' + cutText(li, 1400) + `\n→ 全量：${ref('lessons.md')}`);
  }

  // 5) 最近反思的教训候选
  const rdir = path.join(dir, 'reflections');
  const refl = fs.existsSync(rdir) ? fs.readdirSync(rdir).sort().pop() : null;
  if (refl) {
    const r = readText(path.join(rdir, refl));
    const pick = r.split('## ').find((s) => s.startsWith('五、教训候选')) || '';
    const n = (pick.match(/^\s*-\s+/gm) || []).length;
    // 只给索引：这里原先会列出"print 出现 19 次"之类没有行动价值的统计，纯噪声
    if (n) parts.push(`【最近反思】${refl}｜${n} 条候选（主题分布/错误模式，要归类时读全文）\n→ ${path.join(rdir, refl)}`);
  }

  // 5.5) 当前气氛（情绪系统 v2，2026-10-13；决策见 decisions.md:8）
  //      ⚠️ **位置是设计约束，不是排版偏好**：它必须排在**所有事实段之后**（待办/事件/决策/故障/
  //      程序记忆/教训/反思都是事实段）—— 「事实段永远排在情绪段之前」。这样即使模型只读了
  //      上半段，拿到的也全是事实；气氛段永远只是补充语气与联想权重。
  //      数据源 `mood.json` 在 pages/ 之外 ⇒ 开局注入带着它、但 `recall` 永远搜不到它（test 有断言）。
  //      没有气氛时 formatMoodNote 返回空串 ⇒ 一分预算都不占（与 inbox / watch 段同一策略）。
  //      权重档位（2026-10-13 晚，用户可调低/中/高）：`off` 档时本函数返回空串 ⇒
  //      连那 200 字都不占（档位同时管着排序加权与这里的配额）。
  const moodNote = formatMoodNote(loadMood(dir), currentMoodWeight(dir));
  if (moodNote) parts.push(moodNote);

  // 6) 记忆库定位与用法
  parts.push([
    `【记忆银行】仓库 \`${meta.slug || '?'}\`｜会话 ${Object.keys(meta.sessions || {}).length} 个｜上次摄入 ${meta.lastIngestAt ? zh(new Date(meta.lastIngestAt)) : '从未'}`,
    `目录 \`${dir}\`（知识页 pages/*.md）`,
    '用法：`node E:\\2\\_dsh_memory\\bank\\cli.mjs recall "关键词"` 检索历史｜`… page <文件名>` 读整页｜`… remember "内容" --page x.md` 写入',
  ].join('\n'));

  // —— 分段配额·软目标（2026-09-15 二次调整）
  // 上一版把配额当**硬上限**（超一行就砍），问题是：砍的判据是"段归属 + 行位置"，
  // 跟内容价值无关 —— 待办里第 3 条明明重要，只因为排在后面就被切掉。
  // 现在配额是**软目标**：它只说"这一段预期能用多少"，**内容没超就不截断**；
  // 真正的硬约束只有**总预算**。因此实际用量由「各段自己的选材逻辑」决定
  // （故障按 i、决策按 i、教训按每类最近 N 条…），配额只在某段异常膨胀时兜底。
  // 配套：`cli.mjs sweep` 定期体检低价值条目（内容不无限涨），余量才守得住。
  // 配额合计 6900 < 总预算 8000 —— 即便每段都用满，也仍留 1100 字硬余量。
  // 2026-09-22 加「上次聊到哪」段（600）时从「近期事件」借了 100 ⇒ 合计 **7400**；
  // 2026-10-05 待办段 1200 → 600（改 TOC 索引式注入）⇒ 合计 **6800**，
  // 2026-10-13 加【当前气氛】段（默认档 MOOD_BUDGET=200）⇒ 合计 **7000**，硬余量 1000。
  // 2026-10-18 加【联想收件箱】段（260）⇒ 合计 **7260**（最坏＝气氛高档 7380），硬余量 620。
  //   ⚠️ 10-13 晚起该配额**随权重档位变**（关 0 / 低 120 / 中 200 / 高 320）
  //      ⇒ 最坏（高档）合计 **7120**，仍 < 总预算 8000 ✓；`off` 档时这一段整个不注入。
  //   ⚠️ 这一段**刻意不给多**：气氛是补充信息（只调语气与联想排序权重），事实段才是主体。
  //   没有气氛时 formatMoodNote 返回空串 ⇒ 它平时根本不占那 200 字（与 inbox / watch 段同策略）。
  // 2026-09-16 用户选方案 B 整体放大：总预算 5000 → 8000，各段约 ×1.6 取整。
  // 起因：待办段 700 字被顶死，新待办（ASR）挤不进去，逼得压缩前面几条腾空间 ——
  // 而当时**总预算还余 1146 字**：瓶颈其实在段配额，不在总盘。这也是「分项控制」那条教训的实例。
  const SEG_BUDGET = [
    ['全局偏好', 1750],   // ⚠️ 2026-10-31 起**本段永不截断**：capSeg 对它直接放行（见下面 capSeg 里那一行）。
                          //   用户要求「硬约束一定要保证全注入」⇒ 这行配额只作"预期用量"的记账，不再是上限。
                          //   2026-10-18：1300→1450（新增 0.7 输出方式 / 0.8 不用惊慌；合计 7260→7410）
    ['本仓库待办', 600],    // 2026-10-05 主人要求：注入只留目录块 + 定时条目（实测约 540 字）
                            // 非定时待办改由面板/文件承载 —— 省下的额度留给别的段
    ['待整理队列', 300],   // 2026-09-17 新增：只在 inbox 非空时出现
    ['联想收件箱', 260],   // 2026-10-18 新增：做梦候选的待审摘要（空箱时整段不出现）
    ['备忘录', 200],       // 2026-10-18 新增：备忘/未动工事项摘要（空则整段不出现）
    ['上次聊到哪', 600],   // 2026-09-22 新增：跨会话交接（只在 handoff.md 存在时出现）
    ['近期事件', 800],
    ['重要决策', 800],
    ['故障速查', 800],   // 2026-10-05：实测 746 字 > 700 ⇒ 末尾 i=4 被截断（test「按 i 降序」变红）⇒ 用待办段省下的额度补
    ['程序记忆', 1100],   // 2026-09-17 新增：按 ## 分组、每组取前 2 条
                          // 实测 700 只装得下 2 组 —— cutText 按**行边界**截，而本段每组占一整行（约 260 字），
                          // 所以配额 700 实际只落到 543。要 4 组全进需要 ≈1000。
    ['教训索引', 1150],    // 2026-10-05：改 TOC 索引式（实测 852 字），比原来的逐节「最近 3 条」更省更准
                           // 2026-10-29：900 已不够 —— 实测 11 节 1049 字，cutText 按行边界切到 H0 就停，
                           //   **H0b 与 H（自我复盘）整节被砍**，而 H 恰恰是最该每轮看见的那一节。
                           //   提到 1150（余 100 字 ≈ 1 节），总注入实测 6894 + 250 = 7144，仍在 8000 内。
    ['最近反思', 300],
    ['当前气氛', moodBudget(currentMoodWeight(dir))],   // 2026-10-13 新增；10-13 晚改为**按权重档位取**（别在这里写字面量）
    ['记忆银行', 300],
  ];
  const capSeg = (p) => {
    const m = String(p).match(/^【([^】]+)】/);
    if (!m) return p;
    // 2026-10-31 用户定：「硬约束一定要保证全注入」⇒ 全局偏好段**永不截断**，
    //   既不吃段配额（1750），也不吃上面第 26 行那个（已删除的）2000 字上限。
    //   ⚠️ 只对**这一段**开口子：其余段仍走 cutText，别把这个例外扩散出去。
    if (m[1].startsWith('全局偏好')) return p;
    const hit = SEG_BUDGET.find(([k]) => m[1].startsWith(k));
    if (!hit) return p;
    // ⚠️ 段尾的 `→ ...` 指路行**不参与配额**：实测截断后它会被一起砍掉，
    // 而**被截断的段恰恰最需要"去哪看全量"** —— 那等于把地图跟着风景一起撕了。
    const s = String(p);
    const at = s.lastIndexOf('\n→ ');
    const tail = at === -1 ? '' : s.slice(at);
    const body = at === -1 ? s : s.slice(0, at);
    return cutText(body, hit[1]) + tail;
  };
  return cutText(parts.map(capSeg).join('\n\n'), budget);
}

// ---------------------------------------------------------------- 主干同步
/** 把文本按 `## ` 章节切开（保留原始片段，便于原地替换） */
