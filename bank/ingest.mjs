// ============================================================================
// Memory Bank · ingest —— 从 bank.mjs 拆出（2026-09-22）
//   ⚠️ 本文件**不许 import bank.mjs**（那会循环依赖）；只依赖 node 标准库 + ./core.mjs + 同层模块。
// ============================================================================
import { BANK, clip, day, findTranscripts, fingerprint, nowIso, readJson, readRecords, readText, textOf, writeJson, writeText, zh } from './core.mjs';
import { indexDocs, reindexPage } from './index.mjs';
import path from 'node:path';
import fs from 'node:fs';
export const HEUR = [
  { page: 'preferences.md', test: (s) => /记住|记得|以后都|偏好|我喜欢|我不喜欢|少用|多用/.test(s) },
  { page: 'todos.md', test: (s) => /待办|还没|下次|接下来|TODO|等几天|回头/.test(s) },
  { page: 'environment.md', test: (s) => /[A-Za-z]:\\[^\s]{2,}|安装在|装在|版本\s*[0-9]|端口\s*[0-9]|代理\s*(127|localhost)|解释器|配置\s*[:：]/.test(s) },
  { page: 'lessons.md', test: (s) => /(Traceback|SyntaxError|TypeError|ValueError|KeyError|IndexError|报错|踩坑)[\s\S]{0,80}(因为|原因是|原来是|其实是|改成|应该是|改成|修复|踩坑)/.test(s) },
];






// ---------------------------------------------------------------- 投递门（2026-09-18）
// 背景：`HEUR` 靠**关键词匹配**，分不出「陈述」与「提问 / 指令 / 任务书 / 汇报」——
//   于是用户的提问（"现在待办还有什么要做"）、任务提示词、我自己的过程播报都被抓进 inbox。
//   历史清理记录显示：五清 19 条里 **14 条误抓（74%）**，且病根每次都一样。
//
// 设计：**置信度打分（0~1）而非随机概率**。
//   ⚠️ 随机抽稀只会让噪音「变少」，不会让噪音「占比变少」—— 打分才能真正提纯。
//   门槛 `INBOX_GATE` 可调（0~1）：越高越严。
//
// ⚠️ **只影响「投递」，不影响「记录」** —— journal 仍无条件记录全部用户消息（见 ingest 里
//    `lines.push('- **[用户]** ...')` 那行）。所以证据链一条不少，只是 inbox 不再被噪音塞满。
//
// 标定（2026-09-18）：用 `discarded.json` 的 **35 条历史噪音**回测 ——
//   门槛 0.5 时 **挡下 30 / 保留 5**，且保留的**全部是真偏好陈述**（零误伤）。
export const INBOX_GATE = 0.5;






export function scoreCandidate(raw) {
  const s = String(raw || '');
  let score = 0.65; // 基础分：默认倾向保留（宁可多一条待整理，也别漏掉真知识）

  // ① 疑问句 —— 提问不是素材，是「请求」
  if (/[？?]|吗[。！!]?$|如何|为什么|怎么|是不是|多少|能不能|可不可以|还有什么|是否|哪里|我不知道|不清楚|没看懂|不明白|是干嘛的/.test(s)) {
    score -= 0.5;
  }
  // ② 祈使 / 指令 —— 要求不是素材（`把…改成` 中间可能隔很远，故放宽到 60 字符）
  if (/帮我|麻烦|(讲解|解析|检查|说明|解释|结合|看|改|做|试|查|算|写)一下|把.{0,60}?(改成|加到|加成|去掉|换成)|^来|^给|请(?!完成)/.test(s)) {
    score -= 0.4;
  }
  // ③ 任务提示词 —— 是「任务书」不是知识
  if (/^你是一个|任务[:：]|请完成|如实回报|角色[:：]|^请调研/.test(s)) {
    score -= 0.6;
  }
  // ④ 报错原文但无修复线索 —— 只有现场，没有结论
  if (/(Traceback|File\s+"|\^\^\^|SyntaxError|TypeError|ValueError|KeyError|IndexError)/.test(s)
      && !/(原因|因为|改成|修复|解决|其实是|原来是)/.test(s)) {
    score -= 0.35;
  }
  // ⑤ 助手汇报痕迹 —— 是过程播报，不是用户的知识
  if (/^[⚠️✅❌🔁🗑]|已经顶到|只剩\s*\d+\s*字|我已(经|将)|本次(新增|改动)|但我(昨天)?实测|^次/.test(s)) {
    score -= 0.3;
  }
  // ⑥ 陈述性偏好 —— 加分（这才是真正该留的）
  if (/(我喜欢|我不喜欢|以后都|记住|记得|偏好|继续走|养成了?习惯)/.test(s)) {
    score += 0.3;
  }
  // ⑦ 界面回填 —— **不是用户打的字，是 UI 生成的**（2026-09-18）
  //   `dsh-todo-panel` 的面板点条目会回填「继续做这条待办：<标题>」，措辞完整得像一条真待办，
  //   基础分 0.65 于是稳稳越过 0.5 的门 —— 实测连抓两条进 inbox（每次点面板必抓一条）。
  //   同类文本一律按第 ③ 条「任务书」的力度扣，扣完 0.05 远低于门槛。
  if (/^\s*继续做这条待办[：:]/.test(s)) {
    score -= 0.6;
  }
  // ⑧ 定时派发 —— **同样不是用户打的字**（2026-10-10）
  //   ⑦ 只挡住了面板**回填**（点条目），但 `dsh-todo-panel` 的**定时条目**走的是另一套措辞：
  //   `【定时待办】<正文>（来自待办文件的定时条目，由 dsh-todo-panel 自动派发；规则：…）`
  //   ⇒ ⑦ 上线后它仍往 inbox 攒了 4 条（10-04~10-06，本次清理时实测）。
  //   按 ⑦ 的力度扣，扣完 0.05 远低于门槛；真·待办陈述不含这个前缀，零误伤。
  if (/^\s*【定时待办】/.test(s)) {
    score -= 0.6;
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * 候选指纹（归一化后前 50 字）。
 * 2026-09-18 从 `ingest` 内部提取成导出函数 —— 因为 **inbox 出队工具也要算同一个指纹**
 * （出队时把指纹写进 `discarded.json`，抓取时比对它），两处各写一份必然漂移。
 * 归一化三步：去 `2026-09-17 ` 日期前缀 → 去 `[todos] ` 标签前缀 → 空白折叠 → 取前 50 字。
 */






export function ingest(dir, { transcript, cwd, full = false } = {}) {
  const meta = readJson(path.join(dir, 'bank.json'), {});
  const state = readJson(path.join(dir, 'state.json'), { offsets: {} });
  const list = transcript ? [{ file: transcript }] : findTranscripts(cwd || meta.cwd);
  let added = 0;
  let autoPaged = 0;
  // 复述效应回填（2026-09-17）：见下方循环内的详细说明
  const acc = readJson(path.join(dir, 'access.json'), {});
  let accTouched = false;
  // 共现表（2026-09-17）：同一轮 HITS 里被一起命中的条目 ⇒ 它们相关。
  // 结构 { "A": { "B": 次数 } } 而不是扁平键，查询才能 O(1)（见 search() 的共现联想）。
  // ⚠️ `--full` 语义是"从零重读"，所以共现表必须**一起清空重算** —— 否则每跑一次 --full，
  //    同一轮的共现就被重复累计一次，计数虚高、幂等性破掉（access 用 max() 天然幂等，共现用 += 不是）。
  const co = full ? {} : readJson(path.join(dir, 'cooccur.json'), {});
  let coTouched = false;
  // 已判断过并**丢弃**的候选指纹（2026-09-17）：`inbox.md` 一清空，"靠比对 inbox 内容去重"
  // 就失忆了 —— `ingest --full` 会把同样一批误抓原样重灌回来（实测重灌 19 条、14 条是提问）。
  // 所以把丢弃决定单独落盘，抓取前先比它。
  // ⚠️ 指纹要**两侧归一化**再比：`discarded.json` 里的记录是从 `inbox.md` 行提取的，带
  //    `2026-09-17 [todos] ` 这类前缀，而这里比对用的 `t` 是**纯用户文本**。不归一化就对不上
  //    （第一版就是这么错的：正则写 `\[[a-z]+\.md\]`，而真实前缀是 `[todos]`，没有 `.md`）。
  const fp = fingerprint;   // 复用顶层实现（2026-09-18 提取），避免两处算法漂移
  const discSet = new Set((readJson(path.join(dir, 'discarded.json'), { items: [] }).items || []).map(fp));

  for (const { file } of list.slice(0, full ? 999 : 5)) {
    if (!fs.existsSync(file)) continue;
    const key = path.basename(path.dirname(file));
    let recs;
    try { recs = readRecords(file); } catch { continue; }
    let start = full ? 0 : (state.offsets[key] || 0);
    // 2026-09-15 修复：会话日志被压缩/轮转后记录数会变小，旧偏移超过长度 →
    // slice() 永远返回空 → 该会话被永久漏读。检测到就回退全量。
    if (start > recs.length) start = 0;
    const slice = recs.slice(start);
    if (!slice.length) continue;

    // —— 复述效应回填：hook 跑在 read-only 沙箱、**写不了 access.json**，但它把每轮命中集
    //    通过 stderr 喊了出来（`HITS:页#id,...`），被 DSH 记进会话日志的 hook/result.stderrSummary。
    //    这里（agent 侧，有写权限）把它捞回来。
    //    ⚠️ **必须用记录自身的时间 r.time**，不能用 now() —— 否则几十轮历史命中会全变成"刚刚"，
    //    又一次把时间衰减抹平（那正是 2026-09-17 刚修掉的那个 bug 的另一种形态）。
    //    副产品：同一份 HITS 也是「共现」的原料（自动联想），将来可复用。
    for (const r of recs) {
      if (r.type !== 'hook/result') continue;
      const hm = String(r.data?.stderrSummary || '').match(/HITS:(\S+)/);
      if (!hm) continue;
      const at = Number(r.time) || Date.parse(r.time) || Date.now();
      for (const hid of hm[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        if ((acc[hid] || 0) < at) { acc[hid] = at; accTouched = true; }
      }
    }

    // 共现累计：同一轮 HITS 内的条目**两两相关**（A 出现时 B 也出现 ⇒ 它们是同一话题的两面）。
    // 与 access 同源、同时机 —— 都是"事后从会话日志回填"，因为 hook 自己写不了文件。
    for (const r of recs) {
      if (r.type !== 'hook/result') continue;
      const cm = String(r.data?.stderrSummary || '').match(/HITS:(\S+)/);
      if (!cm) continue;
      const ids = cm[1].split(',').map((x) => x.trim()).filter(Boolean);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i]; const b = ids[j];
          if (a === b) continue;
          if (!co[a]) co[a] = {};
          co[a][b] = (co[a][b] || 0) + 1;
          coTouched = true;
        }
      }
    }

    const users = [];
    const assistants = [];
    const tools = [];
    const pending = [];
    for (const r of slice) {
      if (r.type === 'user/message' && r.data?.source?.kind === 'user') {
        const t = textOf(r.data.content);
        if (t) users.push({ time: r.time, text: t });
      } else if (r.type === 'assistant/message') {
        const t = textOf(r.data?.message?.content);
        if (t) assistants.push({ time: r.time, text: t, turn: r.data?.turn });
      } else if (r.type === 'tool/call') {
        tools.push(r.data?.name);
      }
    }
    state.offsets[key] = recs.length;

    // 写当日流水
    const jfHead = `# 会话流水 ${day(new Date(Number(users[0]?.time) || Date.now()))}\n`;
    const jf = path.join(dir, 'journal', `${day(new Date(Number(users[0]?.time) || Date.now()))}.md`);
    let jfText = readText(jf) || jfHead;
    if (full) {
      // 2026-09-15 修复：--full 从 0 重读全部记录，原逻辑会把同一会话再追加一遍 → 重跑不幂等。
      // 注意：同一会话的流水可能散落在**多个日期文件**里（会话跨天 + 增量写入），
      // 所以必须在整个 journal 目录里清掉该会话的旧段，而不是只清目标文件。
      const jdir = path.join(dir, 'journal');
      for (const f of fs.readdirSync(jdir).filter((x) => x.endsWith('.md'))) {
        const p = path.join(jdir, f);
        const t = readText(p);
        const segs = t.split(/(?=\n## )/);
        const kept = segs.filter((s, i) => i === 0 || !s.startsWith(`\n## 会话 ${key}（`));
        if (kept.length !== segs.length) writeText(p, kept.join('').replace(/\s+$/, '') + '\n');
      }
      jfText = readText(jf) || jfHead;
    }
    if (!jfText.trim()) jfText = jfHead;
    const lines = [jfText];
    lines.push(`\n## 会话 ${key}（本次处理 ${slice.length} 条记录）\n`);
    for (const u of users) {
      const t = clip(u.text, 300);
      lines.push(`- **[用户]** ${zh(new Date(Number(u.time)))} ${t}`);
      added++;
      for (const h of HEUR) {
        if (!h.test(u.text) || t.length < 10) continue;
        // —— 置信度门（2026-09-18）：只挡「投递」，不挡「记录」（journal 上面已无条件记全）。
        if (scoreCandidate(u.text) < INBOX_GATE) continue;
        // 2026-09-15 改投收件箱：自动记录的可靠性不足以直接写进结构化知识页
        // （曾把「现在待办还有什么要做」当成新待办写进 todos.md）。先进 inbox.md 待整理。
        const pf = path.join(dir, 'pages', 'inbox.md');
        const head = '# inbox（自动记录的待整理素材）\n\n> `ingest` 按启发式抓到的候选，**未经验证**；由助手在会话里判断后移入对应知识页，然后从这里删掉。\n';
        const prev = readText(pf) || head;
        if (prev.includes(t.slice(0, 50))) continue;
        if (discSet.has(fp(t))) continue;   // 已判断过并丢弃的候选，不再重抓（归一化后比对）
        writeText(pf, `${prev.replace(/\s+$/, '')}\n\n- ${day()} [${h.page.replace('.md', '')}] ${clip(t, 200)}\n`);
        reindexPage(dir, 'inbox.md');
        autoPaged++;
      }
      pending.push({ id: `journal/${key}/${u.time}`, kind: 'journal', page: jf.replace(BANK, ''), title: `用户 ${zh(new Date(Number(u.time)))}`, text: t });
    }
    for (const a of assistants.slice(-6)) lines.push(`- [助手·轮${a.turn}] ${clip(a.text, 200)}`);
    if (tools.length) lines.push(`- 工具：${Object.entries(tools.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {})).map(([k, v]) => `${k}×${v}`).join('、')}`);
    writeText(jf, lines.join('\n') + '\n');
    indexDocs(dir, pending);
    meta.sessions[key] = { records: recs.length, ingestedAt: nowIso(), lastActivity: recs[recs.length - 1]?.time || null };
  }

  if (accTouched) writeJson(path.join(dir, 'access.json'), acc);
  if (coTouched) writeJson(path.join(dir, 'cooccur.json'), co);
  meta.lastIngestAt = nowIso();
  writeJson(path.join(dir, 'bank.json'), meta);
  writeJson(path.join(dir, 'state.json'), state);
  return { added, sessions: Object.keys(meta.sessions).length, autoPaged };
}

// ---------------------------------------------------------------- 反思
/** 停用词：模板词、虚词、常见英文功能词（保留 Python 关键字如 for/if/in/print） */
