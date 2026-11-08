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

export const ROOT = path.join(BANK, '..', '..');      // E:\2

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

export const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8'); };

export const writeText = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, 'utf8'); };

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
export const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decompressAll(buffer) {
  const marks = [];
  let i = buffer.indexOf(MAGIC);
  while (i !== -1) { marks.push(i); i = buffer.indexOf(MAGIC, i + 4); }
  if (!marks.length) return zlib.zstdDecompressSync(buffer);
  const parts = [];
  let pos = 0;
  while (pos < marks.length) {
    const end = pos + 1 < marks.length ? marks[pos + 1] : buffer.length;
    try { parts.push(zlib.zstdDecompressSync(buffer.subarray(marks[pos], end))); pos++; continue; } catch {}
    let k = pos + 1, ok = false;
    while (k < marks.length) {
      const e2 = k + 1 < marks.length ? marks[k + 1] : buffer.length;
      try { parts.push(zlib.zstdDecompressSync(buffer.subarray(marks[pos], e2))); pos = k + 1; ok = true; break; } catch { k++; }
    }
    if (!ok) break;
  }
  return Buffer.concat(parts);
}


export function readRecords(transcriptPath) {
  const text = decompressAll(fs.readFileSync(transcriptPath)).toString('utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}


export const textOf = (content) => (content || []).filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();

/** 会话日志可能落在哪些 harness home（2026-09-30 新增官方桌面版的 ~/.dsh）。
 *  起因：旧壳用 %APPDATA%\dsh-desktop\harness，官方版用 ~/.dsh ——
 *  只扫一个根，另一个 App 里的对话就永远进不了记忆库（实测 tick 摄入不到）。 */
export function transcriptHomes(extra) {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (!p) return;
    const norm = path.resolve(p).replace(/[\\/]+$/, '');
    if (seen.has(norm.toLowerCase())) return;
    seen.add(norm.toLowerCase());
    try { if (fs.statSync(norm).isDirectory()) out.push(norm); } catch { /* 不存在就跳过 */ }
  };
  add(process.env.DSH_HOME);
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'dsh-desktop', 'harness'));  // 旧壳 DSH Desktop
  if (process.env.USERPROFILE) add(path.join(process.env.USERPROFILE, '.dsh'));            // 官方 DeepSeek Harness
  for (const p of extra || []) add(p);                                                    // 调用方/测试追加
  return out;
}

/** 在 DSH sessions 目录里找某仓库的会话日志（多根合并，见 transcriptHomes） */

export function findTranscripts(cwd, extraHomes) {
  const slug = `--${path.resolve(cwd).replace(/[:\\]/g, '-').replace(/^-+/, '')}--`.toLowerCase();
  const out = [];
  const walk = (d) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl.zstd')) out.push({ file: p, size: fs.statSync(p).size, mtime: fs.statSync(p).mtimeMs, dirName: path.basename(path.dirname(p)) });
    }
  };
  for (const home of transcriptHomes(extraHomes)) walk(path.join(home, 'sessions'));
  // 目录名形如 --E-2--：优先匹配当前仓库，匹配不到就全部返回（由调用方过滤）
  const matched = out.filter((o) => o.dirName.toLowerCase().includes(slug.replace(/^--|--$/g, '')));
  return (matched.length ? matched : out).sort((a, b) => b.mtime - a.mtime);
}


export function fingerprint(s) {
  return String(s || '')
    .replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

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

export const STOP = new Set([
  '用户', '助手', '主人', '一下', '一个', '一些', '什么', '怎么', '这个', '那个', '可以', '应该', '不是', '就是',
  '我们', '你们', '他们', '现在', '还是', '因为', '所以', '但是', '如果', '然后', '已经', '这些', '那些',
  '看看', '帮我', '我想', '时候', '地方', '为什么', '还有', '内容', '结果', '情况', '问题', '方法', '东西',
  '这里', '那里', '没有', '需要', '想要', '知道', '觉得', '开始', '以及', '关于', '一样', '一起', '上面',
  '下面', '之后', '之前', '这样', '那样', '多少', '是不是', '直接', '可能', '不太', '有点', '好像', '确认',
  'the', 'and', 'you', 'that', 'this', 'with', 'have', 'what', 'how', 'why', 'are', 'was', 'were', 'will',
  'can', 'not', 'but', 'its', 'it', 'is', 'in', 'of', 'to', 'as', 'at', 'on', 'by', 'my', 'me', 'we',
  // 2026-09-15 改良：补 Python 关键字与常见代码词 —— 之前把 print / for / range 当成「高频话题」，
  // 反思的第一节与第五节全被代码词占满（连续两日候选八条一字未变，纯属噪声）。
  'print', 'input', 'for', 'if', 'else', 'elif', 'while', 'range', 'def', 'return', 'try', 'except',
  'int', 'str', 'float', 'list', 'dict', 'len', 'type', 'true', 'false', 'none', 'python', 'py',
  'break', 'continue', 'import', 'from', 'class', 'self', 'lambda', 'yield', 'async', 'await',
]);

/** 噪音词判据：空 / 单字 / 纯数字 / 短数字+字母 / 停用词。
 *  ⚠️ 2026-09-19 起**导出**：`cli dream`（找"意外关联"）也要用它 —— 之前它是内部函数，
 *  我在临时脚本里没套用，结果 `758`、`988` 这类数字全被当成"罕见词"混进候选。 */

export const isNoise = (t) => !t || t.length < 2 || /^\d+$/.test(t) || /^\d{1,2}[a-z]{0,2}$/.test(t) || STOP.has(t);

/** 从流水行里剥掉标记与时间戳，只留用户原话 */

export const lineToText = (l) => l
  .replace(/^-\s*/, '')
  .replace(/^\*\*\[(用户|助手[^]]*)\]\*\*\s*/, '')
  .replace(/^\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s*/, '')
  .trim();

// 结构性截断：保留换行和列表结构，只在行边界处切
export const cutText = (s, n) => {
  const t = String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  const cut = head.lastIndexOf('\n');
  return (cut > n * 0.5 ? head.slice(0, cut) : head) + '\n…（已截断，完整内容见对应文件）';
};


export const stripFirstHeading = (s) => String(s || '').replace(/^#[^\n]*\n?/, '').trim();


export function splitSections(text) {
  const out = [];
  for (const p of String(text || '').split(/\n(?=##\s)/)) {
    const m = p.match(/^##\s+(.+?)\s*$/m);
    if (!m) continue;
    const at = p.indexOf(m[0]);
    out.push({ title: m[1].trim(), body: p.slice(at + m[0].length).trim(), raw: p });
  }
  return out;
}

/** MEMORY.md 的哪些章节 ↔ 哪个知识页 */

export const SYNC_MAP = [
  ['主人（用户）画像', 'preferences.md'],
  ['助手的工作习惯', 'preferences.md'],
  ['环境信息', 'environment.md'],
  ['故障备忘', 'faults.md'],
  ['变更记录', 'changelog.md'],
];

/** 行级差异（忽略空白与空行），用于判断"该往哪边同步" */

export const lineSet = (t) => new Set(String(t || '').split('\n').map((l) => l.trim()).filter(Boolean));

export function lineDiff(a, b) {
  const A = lineSet(a);
  const B = lineSet(b);
  return { memoryOnly: [...A].filter((l) => !B.has(l)), pageOnly: [...B].filter((l) => !A.has(l)) };
}

/**
 * 主干同步（2026-09-15 新增）：检查 / 修复 `_dsh_memory/MEMORY.md` 与知识页的共享章节。
 *
 * ⚠️ **默认只报告，绝不自动覆盖** —— 因为"不一致"的两个方向都可能正确：
 *    实测 faults.md 是 MEMORY 那边新（补了坑），environment.md 却是页面那边细（多了权限预设行），
 *    changelog.md 更是差 1000+ 字。盲目单向覆盖必然丢内容。
 *    因此覆盖必须显式给方向：`--apply --from memory|page`，且覆盖前自动备份。
 *    `only: ['faults.md']`（CLI `--only`）把一次覆盖限制在指定页 —— 方向按页不同时必须逐页跑。
 *
 * 非共享章节原封不动（如 environment.md 的 Whale 挂件、临时工具脚本；preferences.md 的"其他"）。
 * 待办不走这里 —— `todos.md` 是待办权威（带 `[x]` 语义，由 tidy 管理）。
 */

export function pageBlocks(lines) {
  const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const headerIdx = new Set();
  for (let i = 0; i < lines.length - 1; i++) if (isSep(lines[i + 1])) headerIdx.add(i);
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isRow = /^\s*\|/.test(l) && !isSep(l) && !headerIdx.has(i);
    const isBullet = /^[-*]\s+\S/.test(l);
    if (isRow || isBullet) {
      if (cur) blocks.push(cur);
      cur = { s: i, e: i };
    } else if (cur && /^\s+\S/.test(l)) {
      cur.e = i;                 // 缩进续行归上一块
    } else if (cur) {
      blocks.push(cur); cur = null;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** 列出某页（或全部页）的条目，附「已有的 i 评分 / 日期 / 长度」—— 给人工判断用 */
