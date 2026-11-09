// ============================================================================
// Memory Bank · core（基础层）—— 从 bank.mjs 拆出（2026-09-22）
//   内容：路径常量 / 基础读写 / 条目元数据 / 仓库定位 / 分词 / 会话日志底层 /
//         文本工具（切分·截断·行差）—— **不含业务逻辑**，被 bank.mjs 与其它子模块共用。
//   ⚠️ 本文件**不许 import bank.mjs**（那会循环依赖）；它只依赖 node 标准库。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { stripFillers } from './text-clean.mjs';
export const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BANK = path.join(HERE, '..');            // _dsh_memory/bank

export const ROOT = path.join(BANK, '..', '..');      // 工作区根（通常是记忆库目录的上一层）

export const REPOS = path.join(BANK, 'repos');

export const GLOBAL_SLUG = '_global';


// ---------------------------------------------------------------- 基础工具
export const nowIso = () => new Date().toISOString();

export const zh = (d = new Date()) => d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export const day = (d = new Date()) => {
  const t = new Date(new Date(d).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
};

export const readJson = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

// —— 原子写（2026-11-08，借 LivingMemory `index_validator_rebuild.py` 的「影子 + 原子切换」）——
// 原实现是裸 `fs.writeFileSync(f, ...)`：写到一半崩 / 被杀 ⇒ **目标文件是半成品**
//   （JSON 截断就直接坏掉，而 `readJson` 的 `catch` 会把它当"空库"返回 ⇒ 静默变成空）。
//   这个隐患是**全库性**的：`writeText`/`writeJson` 有 48 个调用点，覆盖 index.json / access.json /
//   state.json / journal / pages —— 任意一个截断都会变成难查的"数据莫名变少"。
// 它那边的做法是：建影子表 → 建好才 ALTER RENAME 切换 → `if not switched: DROP shadow`（线上一个字节不动）。
//   md+文件系统的等价物 = **同目录临时文件 + rename**：同目录保证同一文件系统，rename 才原子。
// ⚠️ 前提实测过（2026-11-08，win32 / Node 24.21.0）：`fs.renameSync(tmp, 已存在的目标)` **能覆盖**，
//   tmp 消失、内容为新。这是整个改法成立的前提，别凭印象假设 Windows 不行。
// ⚠️ 失败要清理 tmp：否则崩一次就在目录里留一堆 `.tmp-<pid>-<ts>` 垃圾。
export const writeText = (f, t) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.writeFileSync(tmp, t, 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败就算了，别把原始错误盖掉 */ }
    throw e;
  }
};

export const writeJson = (f, o) => writeText(f, JSON.stringify(o, null, 2));

export const readText = (f, fb = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return fb; } };

export const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);


// ---------------------------------------------------------------- 条目元数据
// 2026-09-15 新增：条目级元数据以**行尾 HTML 注释**承载，例如
//   - xxx <!-- i:5 s:user c:high x:2026-12-31 sup:被 yyy 取代 -->
// 好处：人可读、可手改、不破坏 Markdown 渲染。reindex 时抽成 `doc.meta` 并从正文里剥掉
// （否则注释会污染注入）。**只接受白名单取值** —— 页头说明里那行示例注释
// （`s:user|probe|infer`、`i:1-5`、`x:YYYY-MM-DD`）因此不会被误当成真元数据。
// t = tags（2026-09-17 新增）：**主题标签**，用于「标签联想」—— 命中的条目若带标签，
// 可把同标签的其他条目降权附上（见 `search()` 末尾）。⚠️ 标签**不能含空格**（注释按空格切分），
// 多标签用逗号：`<!-- i:5 s:user t:性能,卡顿 -->`。
// 为什么用标签而不是"共现统计"：hook 跑在 read-only 沙箱、写不了文件，共现数据**采不到**
// （见 lessons「DSH hook 沙箱」结论）；而标签是**写条目时就写好的**，完全不碰写入限制。
// 参 subconscious-skill：「本地联想引擎 = 标签 + 关键词 + 项目」。
// rel = 关联边（2026-09-17 新增）：**人工判断过的、精确的**"这条和那条相关"。
// 与 `t:` 标签的分工：标签表达"同主题"（粗、零成本、可批量打），rel 表达"确实相关"
// （精、要思考、按需补）。查询时一跳（不做多跳，避免噪音指数增长）。
// ⚠️ **格式是 `rel:<页>:<关键词>` 而不是 `rel:<页>#<编号>`** —— 因为条目 id 是
// `${pageFile}#${n}`（第几条），**前面一增删就全错位、且静默指错**。用关键词则内容稳定。
// 多项用逗号：`rel:lessons.md:长脚本,faults.md:卡顿`
// pin = 引脚固定（2026-09-17 新增，参 subconscious-skill 的「引脚固定」）：这条**永不因时间而淡忘**。
// 豁免的是**时间性衰减**（时间衰减 + expires）；**不豁免 supersededBy 与 confidence=low** ——
// 那两项说的是"内容已被证明不对/本身就不可靠"，属于**事实问题**，不是新鲜度问题，
// 让 pin 覆盖它们等于用"我很在意"去推翻"它是错的"。用法：`<!-- pin:1 -->`
// cue = 触发词（2026-10-13 新增）：**「看到这个词就想起我」** —— 触发式联想的弹药（见 cue.mjs）。
// 与 `t:` 的分工：t 说「我属于这个主题」（粗、可批量打、同主题互相关联），
// cue 说「别人提到这个词时该把我端出来」（精、要挑词、**不要求对方也带同款标签**）。
// 多项用逗号（不能含空格）：`<!-- cue:乱码,编码,GBK -->`。⚠️ 挑词判据见 cue.mjs 头注释：
// 泛词（库里 >8% 条目都出现）会被 df 门挡掉，**但显式 cue 免检** —— 那是人工判断过的。
export const META_KEYS = { i: 'importance', s: 'source', c: 'confidence', x: 'expires', sup: 'supersededBy', t: 'tags', rel: 'rel', cue: 'cues', pin: 'pin' };

export const META_SOURCES = new Set(['user', 'probe', 'infer']);

export const META_CONFS = new Set(['high', 'mid', 'low']);
/** 关联边的**类型白名单**（2026-09-21，借 Ariadne 的 7 类边）：语义只在**人工建边**时标注。
 *  写法 `rel:<页>:<关键词>:<类型>`；**末段命中此表才算类型**，否则整串仍当关键词 ⇒ 旧格式原样可用。
 *  用途：rel 扩展名额只有 2 个，不够时**标了类型的边优先入选**（人工连语义一起判断过）。 */

export const REL_TYPES = new Set(['causal', 'sequence', 'scenario', 'attribute', 'preference', 'social', 'temporal']);
/** rel 候选的排序策略（导出以便测试）：**标了类型的边优先**，同类型内保持原顺序（sort 稳定）。
 *  为什么需要：rel 扩展名额只有 2 个，而"连语义都判断过"的边比"只写了相关"的边更值得占名额。 */

export function rankRelTargets(list) {
  return [...list].sort((x, y) => (y.type ? 1 : 0) - (x.type ? 1 : 0));
}


export function parseMeta(text) {
  const meta = {};
  const cleaned = String(text || '')
    .replace(/<!--([\s\S]*?)-->/g, (_, body) => {
      for (const part of String(body).split(/\s+/)) {
        const m = part.match(/^([A-Za-z_]+):(.+)$/);
        if (!m) continue;
        const key = META_KEYS[m[1].toLowerCase()];
        const val = m[2].trim();
        if (!key) continue;
        if (key === 'importance') {
          const n = Number(val);
          if (Number.isFinite(n) && n >= 1 && n <= 5) meta.importance = Math.round(n);
        } else if (key === 'source') { if (META_SOURCES.has(val)) meta.source = val; }
        else if (key === 'confidence') { if (META_CONFS.has(val)) meta.confidence = val; }
        else if (key === 'expires') { if (/^\d{4}-\d{2}-\d{2}$/.test(val)) meta.expires = val; }
        else if (key === 'supersededBy') { meta.supersededBy = val; }
        else if (key === 'tags') {
          // 逗号分隔（不能含空格，因为注释按 \s+ 切分）、去重、最多 6 个
          meta.tags = [...new Set(val.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 6);
        }
        else if (key === 'cues') {
          // 同 tags：逗号分隔、去重、最多 6 个（触发词**越少越准**，多了就成噪声源）
          meta.cues = [...new Set(val.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 6);
        }
        else if (key === 'rel') {
          // 只接受 `页:关键词[:类型]`；**故意不接受 `页#编号`** —— 编号会因前文增删而错位、且静默指错
          // 类型用**末段 + 白名单**判定：关键词可能自己含冒号，所以不能简单地按段数切。
          meta.rel = val.split(',').map((s) => {
            const m = s.trim().match(/^([\w.-]+\.md):(.+)$/);
            if (!m) return null;
            const rest = m[2].trim();
            const cut = rest.lastIndexOf(':');
            const tail = cut < 0 ? '' : rest.slice(cut + 1).trim();
            const type = REL_TYPES.has(tail) ? tail : null;
            const key2 = type ? rest.slice(0, cut).trim() : rest;
            return key2 ? { page: m[1], key: key2, type } : null;
          }).filter(Boolean).slice(0, 6);
        }
        else if (key === 'pin') { if (val === '1' || val === 'true') meta.pin = true; }
      }
      return '';
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  return { meta, cleaned };
}

/** 归档页移出检索池（文件保留、`page` 仍可查看，但不再参与召回）—— 「归档 ≠ 遗忘」的修正 */

export const ARCHIVED_PAGES = new Set(['todos-archive.md', 'archive.md']);

/**
 * 元页（2026-09-15 修复）：**别名表是「检索用的索引」，不是「知识本身」**。
 *
 * 它天然由术语清单构成 —— 拿口语去搜，它每一行都命中且覆盖率极高。
 * 实测「电脑变慢 界面发钝 风扇一直响」：top-5 里 **4 条是 aliases.md**，
 * top-1 分数 **10.07**，而真正该回答的 `faults.md` 卡顿条目连前 5 都进不去。
 * 这就是「命中了字典，没命中字典指向的那条知识」——检索把工具当成了答案。
 *
 * 处理：默认**不参加召回**，但**保留索引**（`page aliases.md` 照常可读）；
 * 只有查询自己就想要字典时（说了"别名/术语表/同义词"）才纳入。
 * 注意：查询扩展走的是 `loadAliases()`，它**不依赖 index** —— 静音元页不影响同义救援。
 *
 * 2026-09-22 加入 `handoff.md`（跨会话交接快照）：它是**滚动覆盖的形式化上下文**，
 * 每次 `tick` 都改、且内容就是"最近几轮"，进召回只会冒充"知识"（与 inbox 同类污染）。
 * 它该出现的地方只有一个：开场注入（`bootstrapText` 直接读文件，不经过索引）。
 * ⚠️ 顺带说明：`handoff.mjs` 本来**不调** `indexDoc/reindexPage` ⇒ 它压根不在 index.json 里；
 *    这里登记是**第二道保险** —— 万一有人手动 `reindexPage(dir,'handoff.md')`，也不会污染召回。
 */

export const META_PAGES = new Set(['aliases.md', 'handoff.md', 'memo.md']);   // 2026-10-18 加 agent-todo：过程页，默认不参与召回

/**
 * 元页里**连索引都不该有**的那一类（2026-09-22 加 `handoff.md`）：
 *   `META_PAGES` 的语义是"默认不参加召回、但**显式问起时仍可放行**" —— 别名表就是这种，
 *   所以它**必须留在 index.json 里**（search 的 `wantMeta` 分支要靠它命中，实测挡掉就是回归：
 *   「显式问别名表时才召回 aliases.md」当场变红）。
 *   而跨会话交接快照（handoff.md）是**形式化上下文**：每次 `tick` 都改内容、且只是"最近几轮"，
 *   它**不该是任何意义上的知识** —— 留在索引里只会变成时间衰减追不上的陈旧条目参与召回/做梦
 *   （实测被 `cli dream` 当场报出来：`handoff.md#0` 与 inbox 候选撞出 88% 重叠）。
 *   ⇒ 判据：**"默认静音"和"根本不该存在"是两件事，用两个集合表达，别混。**
 *   它唯一该出现的地方是开场注入（`bootstrapText` 直接读文件，不经过索引 ⇒ hook 零改动）。
 */

export const NO_INDEX_PAGES = new Set(['handoff.md']);

/** 前缀式「连索引都不进」（2026-10-23 加 `days/`）—— 按天索引页（`pages/days/YYYY-MM-DD/*.md`）
 *  是同一件事的**第二处副本**：内容由 `writeDaySplit` 从 journal + 知识页生成。
 *  实测（10-23）：sweep 报的「重复 20 对」里前 15 对全是 `days/2026-10-12/NN-*.md` ↔ `lessons.md#38x`；
 *  索引里当时还躺着 132 条 days 文档 —— 同一份内容被算两遍分，还把 O(n²) 的重复检测拖长。
 *  它该被找到的方式是「打开那一天」（`cli page days/<日期>/<文件>`、grep 照常可用），
 *  **不是**「参与知识召回」⇒ 与 handoff.md 同类处置：从索引这一步就不入池。
 *  ⚠️ 文件仍在磁盘上 —— 静音不等于删除（同 ARCHIVED_PAGES 的处置）。 */
const NO_INDEX_PREFIXES = ['days/'];

/** 页名是否属于「不进索引」（精确集合 ∪ 前缀规则）。调用点：index.mjs 的 guard、sweep 的重复检测 */
export const isNoIndexPage = (page) => NO_INDEX_PAGES.has(page)
  || NO_INDEX_PREFIXES.some((p) => String(page || '').startsWith(p));

/** 别名表：口语 ↔ 术语（`pages/aliases.md`，一行一组、`|` 分隔）。带 mtime 缓存 */

export const aliasCache = new Map();

export function loadAliases(dir) {
  const f = path.join(dir, 'pages', 'aliases.md');
  let mt = 0;
  try { mt = fs.statSync(f).mtimeMs; } catch { return []; }
  const hit = aliasCache.get(dir);
  if (hit && hit.mt === mt) return hit.groups;
  const groups = [];
  for (const line of readText(f).split('\n')) {
    const m = line.match(/^\s*[-*]\s+(?!\[)(.+?)\s*$/);
    if (!m) continue;
    const parts = m[1].split('|').map((s) => s.replace(/<!--[\s\S]*?-->/g, '').trim()).filter(Boolean);
    if (parts.length >= 2) groups.push(parts.map((s) => s.toLowerCase()));
  }
  aliasCache.set(dir, { mt, groups });
  return groups;
}

/**
 * 复述效应（2026-09-15）：被检索命中过的条目，下次更容易再被想起。
 * 单独落 `access.json` 小文件，而不是回写整个 index.json —— 避免写放大与并发覆盖。
 */

export function loadAccess(dir) { return readJson(path.join(dir, 'access.json'), {}); }

export function bumpAccess(dir, ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return;
  // ⚠️ 2026-09-15 关键修复：整个写入**必须容错**。
  // 事故经过：DSH 升到 0.8.2 后，hook 的执行环境变成**独立受限沙箱**（即使会话是
  // `danger-full-access`，hook 里写文件仍然是 `EPERM`）。而 `recall(..., touch: true)`
  // 会走到这里写 `access.json` —— 写失败**抛异常**，一路冒泡到 hook 的 try/catch 里，
  // 于是**整个 user-prompt 失败、`out` 保持空、一条注入都发不出去**。
  // 一个「锦上添花」的功能（复述效应）把**主力功能（召回）**整个拖垮了。
  // 现在：写不进去就静默放弃 —— 复述效应是加分项，永远不该影响召回本身。
  try {
    const a = loadAccess(dir);
    const now = Date.now();
    for (const id of list) a[id] = now;
    const keys = Object.keys(a);
    if (keys.length > 4000) {
      for (const k of keys.sort((x, y) => a[x] - a[y]).slice(0, keys.length - 4000)) delete a[k];
    }
    writeJson(path.join(dir, 'access.json'), a);
  } catch { /* 只读沙箱下静默跳过 */ }
}


export function slugOf(cwd) {
  const p = path.resolve(cwd || ROOT).replace(/[\\/]+$/, '');
  return p.replace(/[:\\/\s]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || '_root';
}


export function repoDir(slug) { return path.join(REPOS, slug); }


export function ensureRepo(slug, cwd) {
  const dir = repoDir(slug);
  for (const sub of ['pages', 'journal', 'reflections']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const meta = path.join(dir, 'bank.json');
  if (!fs.existsSync(meta)) {
    writeJson(meta, { slug, cwd: cwd || null, createdAt: nowIso(), sessions: {}, lastIngestAt: null, lastReflectAt: null, version: 1 });
  } else if (cwd) {
    const m = readJson(meta, {});
    if (m.cwd !== cwd) { m.cwd = cwd; writeJson(meta, m); }
  }
  if (!fs.existsSync(path.join(dir, 'index.json'))) writeJson(path.join(dir, 'index.json'), { docs: [], updatedAt: nowIso() });
  return dir;
}


// ---------------------------------------------------------------- 分词与检索
export function tokenize(text) {
  const t = (text || '').toLowerCase();
  const tokens = [];
  for (const w of t.match(/[a-z0-9_]{2,}/g) || []) tokens.push(w);
  // 2026-09-30：中文**先剥口语停用词再切 bigram**（词表与理由见 `text-clean.mjs` 头注释）——
  // 否则 `时候`/`什么` 这类碎片既撑大覆盖率分母、又给几乎每条文档都加分（噪声地板被顶高）。
  const cjk = stripFillers(t).match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) tokens.push(run);
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

// ---------------------------------------------------------------- 会话日志读取
// 2026-11-09 按域拆到 core-transcript.mjs（core 原 509/510 逼近红线）——这里只转发，接口不变。
export { MAGIC, decompressAll, readRecords, textOf, transcriptHomes, findTranscripts } from './core-transcript.mjs';

/**
 * 行数预算检查（架构红线，2026-09-18 借自 dsh-pet）。
 *
 * 为什么需要：`bank.mjs` 已经 1455 行且还在长（索引 / 检索 / 摄入 / 打分 / Bootstrap 全在里面）——
 * 没有警戒线的话，迟早变成**没人敢碰的巨石文件**。dsh-pet 的做法是给 `window.py` 设行数预算、
 * 超过即 CI 失败，并且明确规定「**预算只随实测校准，不靠压缩行宽/合并语句硬塞**」。
 *
 * 预算表在 `bank/budgets.json`（单一真相源）—— 这里读它、实测各文件行数、给出超限清单。
 * 两个消费者：`cli lines`（给人看）与 `test.mjs`（自动守护，红了即失败）。
 *
 * @param {string} memRoot `_dsh_memory` 目录（预算表里的路径都相对它）
 */

// ---------------------------------------------------------------- 文本工具
// 2026-11-09 按域拆到 core-text.mjs —— 同上只转发，接口不变。
export { fingerprint, STOP, isNoise, lineToText, cutText, stripFirstHeading, splitSections, SYNC_MAP, lineSet, lineDiff, pageBlocks } from './core-text.mjs';

/** 列出某页（或全部页）的条目，附「已有的 i 评分 / 日期 / 长度」—— 给人工判断用 */
