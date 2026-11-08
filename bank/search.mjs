// ============================================================================
// Memory Bank · search —— 从 bank.mjs 拆出（2026-09-22）
//   ⚠️ 本文件**不许 import bank.mjs**（那会循环依赖）；只依赖 node 标准库 + ./core.mjs。
// ============================================================================
import { ARCHIVED_PAGES, GLOBAL_SLUG, META_PAGES, bumpAccess, cutText, loadAccess, loadAliases, rankRelTargets, readJson, readText, repoDir, stripFirstHeading, tokenize } from './core.mjs';
import { loadSynonyms } from './synonyms.mjs';   // 烘焙口语变体（只做检索扩展，见该文件头）
import { moodBoostMax } from './config-keys.mjs';
import { appendAssociations } from './assoc.mjs';   // 联想唯一实现（2026-10-27 收拢，见该文件头）
import { currentMoodWeight, loadMood, moodBoost } from './mood.mjs';
import path from 'node:path';
export function search(dir, query, k = 5) {
  const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
  // —— 当前气氛（情绪系统 v2，2026-10-13）：只用于排序偏置，见下面的接线注释。
  const mood = loadMood(dir);
  // 权重档位（2026-10-13 晚，用户要的「低/中/高」）：它**只缩放下面那个排序加成**，与事实无关。
  const moodLevel = currentMoodWeight(dir);
  // 显式想查字典时才放行元页（"别名表里有哪些组"这类提问仍能命中）
  const wantMeta = /别名|同义|术语表|alias/i.test(String(query || ''));
  // 归档页不进检索池（2026-09-15）：索引里若还残留旧 doc，这里再兜一层
  // 元页默认静音（2026-09-15）：别名表不该跟知识抢召回位 —— 见 META_PAGES 注释
  const docs = (idx.docs || []).filter(
    (d) => !ARCHIVED_PAGES.has(d.page) && (wantMeta || !META_PAGES.has(d.page)),
  );
  if (!docs.length) return [];
  const qt = [...new Set(tokenize(query))];
  if (!qt.length) return [];
  // 别名扩展（2026-09-15）：把口语扩展成术语。扩展词**只加分、不进覆盖率分母** ——
  // 否则「扩展得越多、覆盖率越低」，反而把原本命中的分数稀释掉。
  const qlow = String(query || '').toLowerCase();
  const extAll = [];
  for (const g of loadAliases(dir)) {
    if (g.some((w) => w && qlow.includes(w))) for (const w of g) extAll.push(...tokenize(w));
  }
  // 烘焙同义词（2026-11-02）：LLM 从 cue 术语生成的口语变体，存在 `<repo>/synonyms.json`。
  // 规则与别名表一致（命中即整组扩展、只加分不进覆盖率分母），但**来源隔离**——
  // 它不参与 reflect 主题提取、不进 rel 目标池，原因见 core.mjs 的 loadSynonyms 注释。
  for (const g of loadSynonyms(dir)) {
    if (g.some((w) => w && qlow.includes(w))) for (const w of g) extAll.push(...tokenize(w));
  }
  const ext = [...new Set(extAll)].filter((t) => !qt.includes(t));
  // —— 事件意图识别（2026-11-02 新增）——
  // 为什么：`events.md` 走时间衰减（0.995/小时，7 天压到 ×0.63、30 天 ×0.37），
  // 而 lessons / faults 是常青页**不衰减**。可「最近装了什么」恰恰要找**最近的**事件，
  // 方向完全反了 —— 实测改前 events.md 连 top-10 都进不去（112 条里 32 条相关）。
  // 判据：**只认明确的事件叙事句式**（"…了什么" / "什么时候<动词>"）。
  // 不用「最近 / 上次 / 昨天」这类纯时间词 —— 否则「成考什么时候报名」会被误判
  // （它问的是待办里的未来日期，不是过去发生的事）。
  const wantEvents = /了什么|什么时候(做|弄|搞|装|改|写|跑|发|卸|换)/.test(String(query || ''));
  // 「变更台账」查询（2026-11-02）：问的是**装/改/删/换过什么**，答案一定在事件页，
  // 不在知识页。用它来决定要不要给知识页降权 —— 比"一律降权"精准：
  //   「最近装了什么插件」✅ 命中 → 知识页 ×0.5 → events.md 升到第 1
  //   「上次踩了什么坑」  ✗ 不中 → 不动 → lessons.md 仍是第 1（问经验，知识页本来就对）
  const wantsChangeLog = /(装|改|删|换|配|升级|卸载|安装)了什么/.test(String(query || ''));
  const N = docs.length;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.tokens || [])) df.set(t, (df.get(t) || 0) + 1);
  const idfOf = (t) => Math.log(1 + N / (df.get(t) || 1));
  const access = loadAccess(dir);
  const now = Date.now();
  const scored = [];
  for (const d of docs) {
    const tf = new Map();
    for (const t of d.tokens || []) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    let covered = 0;
    let hasRare = false;
    for (const t of qt) {
      const f = tf.get(t);
      if (!f) continue;
      score += idfOf(t) * (1 + Math.log(f));
      covered++;
      if ((df.get(t) || 1) <= Math.max(1, N * 0.1)) hasRare = true;
    }
    // 别名扩展词：只加分（0.45 折），不参与 covered / ratio
    let extHit = 0;
    for (const t of ext) {
      const f = tf.get(t);
      if (!f) continue;
      score += 0.45 * idfOf(t) * (1 + Math.log(f));
      extHit++;
    }
    if (!covered && !extHit) continue;
    // 2026-09-15 修复：只被一个"烂大街"的词命中 → 噪声（例如搜「Python 解释器 找不到库」
    // 时，仅含 python 的普通对话会挤进结果）。要求：命中 ≥2 个查询词，或命中一个罕见词。
    if (covered < 2 && !hasRare && !extHit) continue;   // 别名扩展命中也算有效线索（同义救援）
    const norm = score / Math.sqrt((d.tokens || []).length || 1);
    // 覆盖率：只用**查询原词**。2026-09-15 曾试过"纯扩展命中时用扩展覆盖率兜底"，
    // 结果收益不足（0.10 → 0.27，仍够不到 0.45）却带来明确副作用 ——
    // 「我学 Python 学到哪了」的 top-1 被顶成 faults.md 的无关条目。**已回退**。
    // 真正该补的不是这块地板，而是下面被漏掉的**标题加成**（见 titleExtHit）。
    const ratio = covered / qt.length;
    const titleLow = String(d.title || '').toLowerCase();
    const titleHit = qt.reduce((n, t) => n + (titleLow.includes(t) ? 1 : 0), 0);
    /**
     * 标题命中「别名扩展词」也算强信号（2026-09-15 修复）。
     * 别名组是**人工核对过的等价说法**，它落在一行的**标题**上（"DSH 页面卡顿 / 渲染进程 CPU 高"）
     * 时，相关性远高于正文里的偶然同现。原先 titleHit 只统计原始查询词 ⇒ 纯同义提问
     * **永远拿不到标题加成**，最强的线索被白白丢掉：实测 faults 那条原始分全场最高（6.99），
     * 最终却只剩 0.10，连 0.45 都过不去。封顶 2 个，防止长标题靠堆扩展词刷分。
     */
    const titleExtHit = Math.min(2, ext.reduce((n, t) => n + (titleLow.includes(t) ? 1 : 0), 0));
    // kind 权重（2026-09-15 新增）：知识页是提炼过的结论，流水只是原始对话片段，
    // 不该同权 —— 否则泛词提问（"什么/优化"）会把一堆无关的用户原话顶上来。
    const KW = { page: 1, reflection: 0.9, journal: 0.6 };
    // 未提炼的原料页【彻底退出召回】（2026-09-16 改）：`inbox.md` 存的是 `ingest` 抓来的**候选**，
    // 常见形态是整段任务提示词（"你是一个…助手。任务：…"），里面会**逐字引用用户的原话**。
    // 原设计只是**降权 0.5**，实测**挡不住** —— 一条这样的提示词在「电脑变慢 界面发钝 风扇一直响」
    // 下覆盖 10/10、拿到 2.26 分，把真正的 `faults.md` 结论挤掉了（更早还有 4.27 / 2.17 的记录）。
    // 参照 scope-recall 的分层原则：**raw turns 是 provenance，不进普通召回** ——
    // 原料要能被召回，必须先**提炼进知识页**（也就是出队；`inbox.md` 的"有进有出"因此更关键）。
    // 用 `continue` 而不是"权重设 0"：权重再低也照样占 `k` 的名额。
    if (d.page === 'inbox.md') continue;
    let s = (norm * (0.2 + 0.8 * ratio) + (titleHit + 0.7 * titleExtHit) * 0.5)
      * (KW[d.kind] ?? 0.7);
    // —— 覆盖率独立加成（2026-11-02）：命中查询词越多，"广度"本身是证据 ——
    //   原来 coverage 只出现在乘子 `(0.2+0.8*ratio)` 里，压不过 `idf×tf`：实测
    //   3/4 覆盖的条目（0.71）被 2/4 覆盖但单词重复多的条目（1.37）压在第 9 名。
    //   调乘子试过（0.05+0.95*ratio）—— 倒挂没改善，反而把「阈值 1.5 的触发」从 9/19 打到 6/19。
    //   ⇒ 改成**独立加项**：不影响 idf 主导的区分度，只把"命中面广"往上抬。
    //   `ratio²` 让"全中"与"中一半"的差距拉开，而不是线性铺平。
    //   系数扫描（同一轮实测）：0.20 → 10/19 触发、噪声 0.89；0.25 → 10/19、0.89；
    //   **0.35 → 12/19、0.90**（召回最高）。0.35 的噪声只多 0.01，取它。
    //   ⚠️ **事件查询除外**：加了这项之后「最近装了什么插件」的 top-1 从 events.md(1.85)
    //   被 lessons.md(3.66) 抢走 —— 事件叙述天然用词不同（"装了" vs "安装"），
    //   拿覆盖率去奖它等于奖励"措辞撞车"。事件查询要的是**时间和发生了什么**，
    //   已经在上面按标题日期加成了，这里不再叠覆盖率。
    if (!wantEvents) s += 0.35 * ratio * ratio;

    // —— 元数据权重与软遗忘（2026-09-15）：**只降权，绝不删物理内容**
    const m = d.meta || {};
    if (m.confidence === 'low') continue;                     // 低置信（模型推断）不进结果 → 也进不了注入
    if (m.supersededBy) s *= 0.25;                            // 已被取代（⚠️ pin 不豁免：这是事实问题）
    const pinned = m.pin === true;                             // 引脚固定：永不因时间淡忘
    if (!pinned && m.expires && Date.parse(m.expires) < now) s *= 0.35;  // 已过期（pin 豁免）
    s *= 1 + 0.15 * ((m.importance || 3) - 3);                // 重要度：i=5 ×1.3，i=1 ×0.7
    if (m.confidence === 'mid') s *= 0.85;

    // —— 时间衰减 + 复述效应：只压「事件流」，常青知识页**不衰减**
    // （否则 lessons / faults / environment 会被日子埋掉，那是净损失）
    // pin 的条目连这一步也跳过 —— 这正是「引脚固定」的意义所在。
    const stream = d.kind === 'journal' || d.page === 'events.md';
    const mild = d.kind === 'reflection' || d.page === 'decisions.md';

    // —— 事件查询时知识页降权（2026-11-02）——
    // ⚠️ 必须放在 `stream` / `mild` **定义之后**：早一版插在 `s += 0.35` 旁边，
    //    因为 `wantEvents &&` 短路，普通查询不炸、事件查询直接
    //    `ReferenceError: Cannot access 'stream' before initialization`（probe 才发现）。
    // 理由：实测「最近装了什么插件」时 lessons.md 靠 4/4 全覆盖（含碎片 `近装`）拿 3.31 排第 1，
    // 而真正的 events.md 只命中 1/4（`插件`）得 1.85。问「最近装了什么」要的是**发生过什么**，
    // 不是**学到什么** —— 知识页靠"用词撞车"拿覆盖率是假信号。
    // 只降 0.5 是因为「最近装了什么插件」的 lessons.md 3.31 太强：0.7 只降到 2.32，
    // 仍压着 events.md 的 1.85（顺序不变 = 白改）；0.5 才翻盘。
    // 触发条件用 `wantsChangeLog` 而不是 `wantEvents` —— 后者会连「踩了什么坑」一起降，
    // 把该赢的知识页压到 0.57 vs events 0.55（险胜），太脆。
    if (wantsChangeLog && !stream && !mild) s *= 0.5;

    if (wantEvents && (stream || mild)) {
      // 事件查询：**反着来** —— 不衰减，按标题里的日期做新鲜度加成（越近越高，最高 ×1.8）。
      // 日期只从 title 解析：`d.updated` 是**索引重建时间**（实测 events 前 4 条同为
      // `2026-10-13T00:45:46.939Z`，同一毫秒），拿它算新鲜度等于整页同权，毫无区分度。
      const dm = String(d.title || '').match(/(\d{4})-(\d{2})-(\d{2})/);
      if (dm) {
        const days = Math.max(0, (now - Date.parse(`${dm[1]}-${dm[2]}-${dm[3]}`)) / 86400000);
        const fresh = Math.max(0, Math.min(1, 1 - days / 90));   // 90 天内线性，更早记 0
        s *= 1 + 0.8 * fresh;
      } else {
        s *= 1.25;   // 标题无日期：整页小幅提升，但仍低于带近期日期的条目
      }
    } else if ((stream || mild) && !pinned) {
      const last = Math.max(access[d.id] || 0, Date.parse(d.updated || '') || 0);
      if (last) {
        const decay = Math.pow(stream ? 0.995 : 0.998, Math.max(0, (now - last) / 3600000));
        // 下限 0.35：**软遗忘是「降权」，不是「归零」**。若直接用 0.995^Δt 当乘子，
        // 30 天前的条目会掉到 0.027 倍（实测分数 3.4 → 0.09），连 0.45 阈值都过不去
        // —— 等于「一个月前的事永远想不起来」，那是硬遗忘，违背设计初衷。
        s *= 0.35 + 0.65 * decay;
      }
    }
    // —— 情绪加权（情绪系统 v2，2026-10-13；权限表见 decisions.md:8）——
    //   ⚠️ **只加在 `rank`（排序偏置），绝不加进 `score`**。这是整套隔离的关键一步：
    //     · `score` = 事实通道：recall 的 minScore 门槛、hook 的 INJECT_MIN_SCORE 触发判定都用它
    //       ⇒ 情绪**永远无法**把一个够不到门槛的条目捞出来（"不得越过相关性门槛"由构造保证）；
    //     · `rank` = 记忆通道：只决定**同批已过门槛的条目里谁先浮现**（人心情差时相关的事更容易想起）。
    //   上限取自**权重档位**（`moodBoostMax(moodLevel)`，2026-10-13 晚做成用户可调）双保险：
    //   moodBoost() 内部已封顶，这里再夹一次 —— 上游改了算法也不会偷偷放大情绪的分量（有断言）。
    //   为什么不是"给情绪条目打更高分"：那会让情绪变成证据。这里情绪只当**排序的助推**，不当分。
    const mb = Math.min(moodBoost(d, mood, moodLevel), moodBoostMax(moodLevel));
    scored.push(mb > 0 ? { ...d, score: s, moodBoost: mb, rank: s + mb } : { ...d, score: s });
  }
  const top = scored.sort((a, b) => (b.rank ?? b.score) - (a.rank ?? a.score)).slice(0, k);

  // —— 联想（2026-10-27 收拢到 assoc.mjs:23）——
  //    ⚠️ 此前本文件与 assoc.mjs 各有一份**逐字相同**的实现，`appendAssociations` 成了零调用方，
  //    改 assoc.mjs 不生效（真正在跑的是这一份）。现在只保留一行调用，唯一实现在 assoc.mjs。
  //    行为变化：三类各 2 个名额 → 一个池按「边权 + 跳数」取前 5，并新增 1 条 2 跳。
  appendAssociations(top, docs, dir, query, idfOf);
  return top;
}

/**
 * 条目型页面（2026-09-15）：这类页的价值在**条目**上（一行一个事件 / 决策 / 教训）。
 * 若仍按 `##` 节整块索引，条目级元数据（importance / confidence / superseded）会互相覆盖
 * 退化成"节级"，召回也只能返回一整节 1200~1500 字。改为逐条切分 → 元数据真正生效、召回更准更省。
 */

// ---------------------------------------------------------------- 召回
/** 理由层入口。⚠️ 2026-10-05 事故：原实现随 search.mjs 今天版本一起丢失（误回滚），
 *  而 bank.mjs 的对外接口仍导出它、且全库暂无调用者 ⇒ 先以转发兜底，保证记忆银行能跑。
 *  待办：确认原语义（应返回带"为什么命中"的理由）后补回。 */
export function searchDetailed(dir, query, opts = {}) {
  return search(dir, query, opts.k ?? 5);
}

export function recall(dir, query, { k = 5, budget = 1500, minScore = 0.45, touch = false, dedupeSelf = true, wantTrace = false } = {}) {
  // 2026-09-15：加 minScore 过滤 —— 宁可返回"没找到"，也别把低分噪声塞进上下文
  // 自命中过滤（2026-09-15）：journal 里存着用户的**原话**，拿提问去搜必然命中「自己」——
  // 把用户刚说的话当「记忆」还回去，零信息量还白占注入预算（实测 top 分数 41.6 全是自命中，
  // 那个 100% 的"命中率"因此是虚高的）。
  // 判据用**覆盖率**（查询词有多少落在该片段里）而不是 Jaccard —— 流水片段带着时间戳与
  // `**[用户]**` 标记，这些额外 token 会把 Jaccard 稀释掉，短查询就漏过去了。
  // 只对 `kind: 'journal'` 生效，知识页条目不受影响（免得「闰年判断」这种查询把同名知识条目误杀）；
  // 长提问（>60 字，多为粘贴的整段代码/长句）用更松的阈值。
  let hits = search(dir, query, k * 3).filter((h) => h.score >= minScore);
  // 2026-10-21：默认排除 journal（流水是原料、不是知识）。原先只靠 dedupeSelf 的覆盖率过滤，
  //   实测覆盖率 75% 的流水片段能漏过去并抢 top-1（「循环次数不能填小数」→ journal 1.51）。
  //   要流水（问「今天做了什么」）时传 wantTrace: true。
  if (!wantTrace) hits = hits.filter((h) => h.kind !== 'journal');
  if (dedupeSelf) {
    const qset = new Set(tokenize(query));
    const thr = String(query).length > 60 ? 0.6 : 0.8;
    hits = hits.filter((h) => {
      // 2026-09-15 修正：原先只过滤 `kind === 'journal'`，**放过了 `inbox.md`** ——
      // 实测「电脑变慢 界面发钝 风扇一直响」的 top-1 正是一条任务提示词（覆盖 10/10、2.26 分）。
      // 2026-09-16 起 `inbox.md` 已在**打分阶段直接 `continue` 排除**（见该处注释），
      // 这里的 `h.page === 'inbox.md'` 保留为**第二道防线**；痕迹页按同一把尺子过滤。
      const isTrace = h.kind === 'journal' || h.page === 'inbox.md';
      if (!isTrace || !qset.size) return true;
      const tset = new Set(tokenize(h.text));
      let inter = 0;
      for (const t of qset) if (tset.has(t)) inter++;
      return inter / qset.size < thr;
    });
  }
  hits = hits.slice(0, k);
  const gdir = repoDir(GLOBAL_SLUG);
  const gt = readText(path.join(gdir, 'pages', 'preferences.md'));
  const lines = [];
  let used = 0;
  if (gt.trim()) {
    const g = '【全局偏好】\n' + cutText(stripFirstHeading(gt), 400);
    lines.push(g);
    used += g.length;
  }
  for (const h of hits) {
    // ⚠️ 2026-09-15 修复：这里原先用 clip()，把所有换行压成空格，召回内容糊成一坨。
    //    同理 index.json 里存的 text 也不能用 clip（见 reindexPage），否则源头就没换行。
    const seg = `【${h.kind}｜${h.title}】\n${cutText(h.text, 420)}`;
    if (used + seg.length > budget && lines.length > 1) continue;
    lines.push(seg);
    used += seg.length;
  }
  // 复述效应（2026-09-15）：命中即刷新访问时间，让「用过的记忆」下次更容易被想起
  if (touch) bumpAccess(dir, hits.map((h) => h.id));
  return { hits, text: lines.join('\n') };
}

// ---------------------------------------------------------------- 会话启动摘要
// 注意：不要在这里用 clip() —— 它会把所有换行/缩进压成单个空格，
// 结构一没，模型读长文本的注意力就明显下降（2026-09-14 修的 bug）。
