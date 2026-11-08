/**
 * 配置键登记表（单一真相源）—— 借自 `MerZlin/dsh-pet-indesktop` README 的做法：
 *   原话「新增普通顶层配置键必须三处同步登记：默认值 dict + reload 白名单 + 快照测试」。
 *   我们的等价三处：① **值**只在本文件定义（别处一律 import，禁止再写字面量）；
 *   ② `CONSUMERS` 写明「谁在用它」（＝ reload 白名单）；③ test.mjs 断言「声明的消费点确实引用了本表」。
 *
 * 为什么必须这样 —— 2026-09-19 实测到的漂移（不是假想）：MIN_SCORE 于 09-17 由 1.2 上调到 1.5，
 * 而 `recall-eval.mjs` 自己抄了一份、唯一对齐手段是行尾注释；`bank.mjs` 两处注释至今写着 1.2。
 * 总预算 8000 更是在 4 处各写一遍。**纸面约定（注释）挡不住漂移，只有「单一真相源 + 测试守护」能。**
 */

/** 开场注入总预算（字）。超出后按段从尾部截断，见 bootstrap.mjs 的 SEG_BUDGET。 */
export const INJECT_BUDGET = 8000;

/**
 * 主注入触发的最小检索分。标定史：1.2 → 1.5（2026-09-17）—— 起因不是检索变差，
 * 而是**噪声地板随知识库增长上漂**（0.64 → 0.79，1.2 的余量掉到 1.5×；经验上低于 2× 该警惕）。
 * 改这个值前先读 `recall-eval.mjs` 的阈值体检表。
 * 样本对照（2026-09-15，27 条：相关 19 / 无关 8）：阈值 3.0 → 相关 2/19；1.2 → 11/19；1.0 → 13/19；
 * 无关组最高仅 0.40 ⇒ 1.2 有约 3× 余量。阈值只决定**触发频率**，不改单次注入字数（都贴 budget 上限）。
 */
export const INJECT_MIN_SCORE = 1.5;

/** 跨会话交接（2026-09-22 用户拍板）：保留上一会话**最后几轮**。5 轮＝够接上上下文又不挤预算。 */
export const HANDOFF_TURNS = 5;

/** handoff 段的注入预算（字）＝**渲染出来的那一段**（含段标题与 `→ 详情` 行）。
 *  标定史：实测 429 → 472 → **549**（2026-09-22 一晚三次，因为最近几轮我自己回复变长了）⇒ 定 **620**。
 *  ⚠️ 它会随"我说话的长度"漂，`test-handoff.mjs` 有断言盯着：渲染超本值即变红 ——
 *  **红了先看是不是真变长，再按实测往上调**（本次就是）。
 *  ⚠️ **「整段」这三个字是这轮修出来的（2026-10-10）**：`formatHandoff` 只保证**轮次正文** ≤ 本值，
 *  头尾壳（约 140 字）原先两头都不管 ⇒ 正文一顶满整段就冲到 633（此后 test 时红时绿，取决于上一会话话多话少）。
 *  现在由 `bootstrap.mjs` 扣壳长（含 cutText 的截断标记余量）兜住整段，测试另有**构造数据**的确定性断言。 */
export const HANDOFF_CHARS = 620;

/** 退化审计只扫最近几个会话文件、只最近多少小时（sweep 要快）。 */
export const DEGEN_MAX_FILES = 4;
export const DEGEN_WINDOW_H = 48;

/**
 * 碎片复读判据（坡面二型，2026-10-08 新增）—— **回放标定出来的值，别再凭感觉改**。
 * 判据：同一步里「思考 ≥ FRAG_MIN_CHARS」且「同一短句重复 ≥ REPEAT_MIN」且「碎片比 ≥ FRAG_RATIO_MIN」。
 * 标定样本：本仓库 85 个会话日志 / 7681 步（`frag-detect.mjs` 头部有完整对照表）。
 * 该组合下命中 5 个会话文件、**全是真复读**（「好」×757、×216、×132，「写」×93），其余 80 个文件 0 命中。
 * ⚠️ 单独放宽任一条都会掉进虚警：单看 repeat≥10 会命中 457 步（技术词与代码片段的正常机械重复）。
 */
export const FRAG_MIN_CHARS = 400;
export const FRAG_RATIO_MIN = 0.20;

/**
 * 自促词复读阈值（坡面三型，2026-11-02 新增）—— 上面那条的补丁，**回放标定过，别再凭感觉改**。
 * 起因：用户贴出上个会话 turn 41 的思考截图（「做。」×16），而二型判据 **0 命中** ——
 * 那三段思考的 `fragRatio` 只有 0.06~0.11（「做。」夹在大段分析中间，碎片字符被长句稀释）。
 * 判据：同一步里「思考 ≥ FRAG_MIN_CHARS」且「同一**自促词**短句重复 ≥ 本值」 ⇒ 命中，**不看碎片比**。
 * 标定（2026-11-02 全库回放：271 个会话文件 / 16270 个带思考的步）：
 *   命中 16 个会话文件 —— 10 个连续 ≥2 步（**全是已知坏会话**：好×757、×216、×132，写×93，做×19…），
 *   另 6 个只命中 1 步（正常口癖量级）。技术噪声（`</p`×36、`go.`、`code:`）因不在自促词表内被天然挡掉。
 * ⚠️ 取 10 而不是 8：8 时同一批 16 个会话只多出步数、不新增会话 ⇒ 没有更早发现，只多噪声。
 */
export const SELF_REPEAT_MIN = 10;

/**
 * 触发式联想（cue，2026-10-13 新增）—— **全部是拿真库回放标定出来的，别再凭感觉改**。
 * 标定样本：本仓库 815 条 doc（每条的正文 df 与占比见本地 budgets-history.md 的 _rebudget_note_20261013）。
 * 关键一条是 `CUE_DF_MAX`：泛词当触发词会让装置**每轮都触发**（实测「插件」出现在 14.4% 的条目、
 * 「DSH」29.9%、「验证」16.7%），而用户举的例子全在安全区（乱码 2.6% / 编码 3.1% / BOM 2.8%）
 * ⇒ 取 8% 为界。2026-10-13 只管 `t:`；**2026-10-29 推翻**：「实测」23.4% 却只挂 1 条 ⇒ p=1.00 独占唯一的 CUE_BODY_HITS ⇒ `cue:` 现与 `t:` 同门（人工标注≠不写泛词；挡不住的环境/静默/rev 靠删标注，详见 lessons.md H 节）。
 * ⚠️ 注意：改这组值要连**两个模式**一起想 —— output 模式（工具输出，动辄几 KB 文本）
 * 只认 cue 档，prompt 模式才三档全开，理由见 cue.mjs 头注释。
 */
export const CUE_DF_MAX = 0.08;
/** `output` 模式（工具输出）额外的**词筛**：库内 df 高于本值的词在工具输出里一律不触发。
 *  标定（2026-10-13，500 条真实 tool/result 回放）：初版命中率 **55%** —— 太高；元凶是
 *  `write` 16.6% / `hook` 16.8% / `window` 11.2% 这类**我自己工作领域的高频词**，取 5% 全挡住，
 *  同时保住了用户的例词（乱码 2.8% / GBK 1.2% / BOM 2.8%）。⚠️ 对 `cue:` 也生效（那才是"人工
 *  标注"该守的底线：挑的是"你会看到的那串原文"，不是"我常说的词"）；prompt 模式不受影响。 */
export const CUE_DF_MAX_OUTPUT = 0.05;
export const CUE_MIN_LEN = 2;
export const CUE_MAX_LEN = 8;
/** `cue:` 档的长度上限（比标签宽）：它可以是**一整段报错原文**（如 `has not been read`）。
 *  注释按空白切分 ⇒ 原文里的空格写 `+`（buildCueTable 还原），故本值按还原后的长度算。 */
export const CUE_MAX_LEN_CUE = 30;
// cue 注入的两级名额（2026-10-26 重做：原来 `CUE_MAX_HITS=2` 是**假名额** —— 每条「标题 44 +
// 正文 180」≈224 字而 `CUE_BUDGET` 只有 240，实测第 2 条永远进不来、第 1 条还被砍在「修法」之前）。
// 现在：扫 8 条 → 概率打分 → 1 条带正文（判断权回交推理，其余只给路牌）。
export const CUE_MAX_HITS = 8, CUE_BODY_HITS = 1, CUE_MAX_ROADS = 4;
/** cue 段预算（240 → 320）：正文 ≈ 190 + 路牌 4×28。 */
export const CUE_BUDGET = 320;
export const CUE_ENTRY_CHARS = 180;

/**
 * 情绪系统 v2（mood，2026-10-13；权限表见 decisions.md:8）。
 * ⚠️ `MOOD_BOOST_MAX`（决策写死的 +0.15 上限）只加在 `rank`（排序）上，**不加进 `score`**（事实通道）
 * —— 接线点在 search.mjs。这样「情绪不得越过相关性门槛」是**构造保证**，不靠自觉。
 * （这里曾经还有 5 个「审计」相关的键：扫会话日志算「压力轮 → 改口率」。当天就删了 ——
 *   那份统计采样的是**用户自己的话**，对象错了，理由见 mood.mjs 头注释。）
 */
export const MOOD_HISTORY_MAX = 30;      // 气氛历史保留条数（软遗忘：只留最近）

/** 情绪权重档位（2026-10-13 用户：「只要一个情绪权重，后面有几个选项低/中/高」）——
 *  **一个旋钮同时缩放内部两个数**。三条守线：① 本表是唯一真值（`MOOD_BOOST_MAX` / `MOOD_BUDGET`
 *  已降级为「默认档的值」，消费点走 `moodBoostMax(level)` / `moodBudget(level)`）；② **任何档位
 *  都不许把加成加进 `score`**（事实通道）—— `off` 是「完全关掉」而非「调得很小」；③ `boost`
 *  的天花板就是本表，别为了「再明显一点」往上加：它只该影响「先想起谁」。
 *
 *  ⚠️ **`danger` / `extreme` 是 2026-10-13 深夜用户点名加的「危险档」**（原话：「再加一个选项开启
 *  有危险提示，并且情绪权重拉的很高，字数配额虽然不怎么加但是会优先注入」）。它们**故意**破了
 *  v2 的两条地基，代价记在 decisions.md 那一条里：
 *    · **配额只从 320 加到 360**（用户要的是"不怎么加"）—— 权重翻倍甚至拉满，但**不靠灌字数**；
 *    · **气氛段提前注入**（提到【全局偏好】之后）⇒ 它从"读完事实后的补充"变成"读事实前的定调"，
 *      这是典型 priming —— 所以段头必须打危险标记（见 mood.mjs 的 formatMoodNote）；
 *    · **写气氛可以不带 `--evidence`**（普通档仍然拒写）⇒ 裸写的每条都打 `unsafe: true` 留痕。
 *  ⚠️ **不破的那条**：`score`（事实分）在任何档位下**一个字都不许变** —— 极限档也只是排得靠前。 */
export const MOOD_WEIGHTS = {
  off:     { boost: 0,    budget: 0   },   // 关：不排序、不注入（等于关掉整套情绪）
  low:     { boost: 0.07, budget: 120 },
  mid:     { boost: 0.15, budget: 200 },   // 中＝默认
  high:    { boost: 0.30, budget: 320 },
  danger:  { boost: 0.60, budget: 360 },   // ⚠️ 危险档：权重翻倍 + 气氛提前注入 + 可无证据写气氛
  extreme: { boost: 1.00, budget: 360 },   // ⚠️ 极限档：加权拉满，配额与危险档同（不靠灌字）
};
export const MOOD_WEIGHT_DEFAULT = 'mid';
/** 档位中文名（注入段与 CLI 报告共用，只此一处）。 */
export const MOOD_WEIGHT_NAMES = { off: '关', low: '低', mid: '中', high: '高', danger: '危险', extreme: '极限' };
/** 「危险档」= 会提前注入气氛段、且允许无证据写气氛的那几档（界面/CLI 都要给红字提示）。 */
export const MOOD_DANGER_LEVELS = ['danger', 'extreme'];

/** 规整成合法档位名；认不出就退默认档 —— **不抛错**，配置坏了不该让记忆银行停摆。 */
export function parseMoodWeight(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s in MOOD_WEIGHTS) return s;
  const hit = Object.entries(MOOD_WEIGHT_NAMES).find(([, n]) => n === s);
  return hit ? hit[0] : MOOD_WEIGHT_DEFAULT;
}
export function moodBoostMax(level) { return MOOD_WEIGHTS[parseMoodWeight(level)].boost; }
export function moodBudget(level) { return MOOD_WEIGHTS[parseMoodWeight(level)].budget; }
export function isDangerWeight(level) { return MOOD_DANGER_LEVELS.includes(parseMoodWeight(level)); }

/** @deprecated 默认档的值（派生自本表，保留只为不炸旧引用）；按档位取用上面两个函数。 */
export const MOOD_BOOST_MAX = MOOD_WEIGHTS[MOOD_WEIGHT_DEFAULT].boost;
export const MOOD_BUDGET = MOOD_WEIGHTS[MOOD_WEIGHT_DEFAULT].budget;

/**
 * 消费点登记：键名 → 引用它的文件（仓库内相对路径）。
 * ⚠️ 加新消费点时必须同时改这里，否则 test.mjs 的登记断言会红（这正是它的用途）。
 */
export const CONSUMERS = {
  INJECT_BUDGET: ['bank/cli.mjs', 'bank/bank.mjs'],
  INJECT_MIN_SCORE: ['bank/hooks/user-prompt.mjs', 'bank/recall-eval.mjs'],
  HANDOFF_TURNS: ['bank/handoff.mjs', 'bank/test-handoff.mjs'],
  HANDOFF_CHARS: ['bank/handoff.mjs', 'bank/bootstrap.mjs', 'bank/test-handoff.mjs'],
  DEGEN_MAX_FILES: ['bank/degenerate-audit.mjs'],
  DEGEN_WINDOW_H: ['bank/degenerate-audit.mjs'],
  FRAG_MIN_CHARS: ['bank/frag-detect.mjs'],
  FRAG_RATIO_MIN: ['bank/frag-detect.mjs'],
  SELF_REPEAT_MIN: ['bank/frag-detect.mjs'],
  CUE_DF_MAX: ['bank/cue.mjs'],
  CUE_DF_MAX_OUTPUT: ['bank/cue.mjs'],
  CUE_MIN_LEN: ['bank/cue.mjs'],
  CUE_MAX_LEN: ['bank/cue.mjs'],
  CUE_MAX_LEN_CUE: ['bank/cue.mjs'],
  CUE_MAX_HITS: ['bank/cue.mjs'],
  CUE_BODY_HITS: ['bank/cue-render.mjs'],   // 下面 4 个随打分/渲染搬到 cue-render.mjs（2026-10-26 按域拆）
  CUE_MAX_ROADS: ['bank/cue-render.mjs'],
  CUE_BUDGET: ['bank/cue-render.mjs'],
  CUE_ENTRY_CHARS: ['bank/cue-render.mjs'],
  // ⚠️ 2026-10-13 晚：`MOOD_BOOST_MAX` / `MOOD_BUDGET` 已**降级**为「默认档的值」（派生自 MOOD_WEIGHTS），
  //    不再是独立可调键 ⇒ 从登记表移除。**要调档位请改配置、别去找这两个常量**：
  //    `cli mood weight off|low|mid|high`（写 `repos/<slug>/mood-config.json`）。
  MOOD_WEIGHT_DEFAULT: ['bank/mood.mjs'],
  MOOD_WEIGHT_NAMES: ['bank/mood.mjs', 'bank/commands/mood.mjs'],
  MOOD_HISTORY_MAX: ['bank/mood.mjs'],
};
