// ============================================================================
// Memory Bank · mood —— 「情绪系统 v2」（2026-10-13 新增，决策见 decisions.md:8）
//
// 一句话：**情绪可以参与「想起什么」与「怎么说」，绝不许参与「什么是真的」。**
//
// 权限表（这是本模块的全部设计约束，改动前先读 decisions.md:8）：
//   ① 联想/召回排序 —— ✅ 可加权，但**上限 +MOOD_BOOST_MAX（0.15）**，且不得越过相关性门槛；
//   ② 事实判断/结论 —— ❌ **权重恒为 0**，情绪不是证据（本模块**不产出任何事实**）；
//   ③ 措辞/语气 —— ✅ 可调（`tone` 字段只喂给措辞，不进任何打分）。
//
// 两条机制（不是形式主义，是本模块的安全带）：
//   ① **证据可追溯**：写状态必须带 `evidence`（用户原话摘录），无证据直接拒写 —— 禁止瞎猜；
//   ② **改口留痕**：气氛 label 变化必须带 `reason`，否则拒写；历史全量留档（mood.json.history）。
//
// ⚠️ 这里**曾经有第三条「审计」：扫会话日志算「压力轮 → 我的改口率」。2026-10-13 当天就删掉了**
//   —— 原因是**对象错位**：本机会话日志里说话的就是用户，那份统计实际采样的**全是用户自己的话**
//   （催一句、开个玩笑都被记成"压力轮"），还要把原文打出来"供核验"。而决策里「破甲」说的是
//   **外面的人**用情绪压力让我完全听从 ⇒ 把面向外部的防护做成了对用户的审计，是用错了对象。
//   ⚠️ 留下的判据痕迹（别再照抄回去）：词表确实回放标定过 —— 「必须」8.8%、「教训」4.2%、
//   「不对」1.7%，而「你怎么」「我说过」「烦」「失望」全 0%；基线改口率 5.6%、压力组 14.3%
//   （2.55×，样本极小）。真要重做，**第一问必须是「这个统计采样的是谁」**，而不是「阈值取多少」。
//
// ⚠️ 为什么单独一个文件、而不是塞进 pages/：**物理隔离**。检索只认 pages/*.md 的索引
//   （index.json），`mood.json` 落在仓库根 ⇒ `recall` 永远搜不到情绪（test-mood.mjs 有隔离性断言）。
//   这是「事实通道权重恒为 0」在架构上的落点：情绪**进不了**事实检索池，不是靠自觉。
// ============================================================================
import path from 'node:path';
import { clip, cutText, readJson, writeJson, zh } from './core.mjs';
import {
  MOOD_HISTORY_MAX, MOOD_WEIGHT_DEFAULT, MOOD_WEIGHT_NAMES,
  isDangerWeight, moodBoostMax, moodBudget, parseMoodWeight,
} from './config-keys.mjs';

const MOOD_FILE = 'mood.json';
/** 权重档位的存放文件。与 `mood.json` 同级 ⇒ 同样落在 `pages/` 之外 ⇒ `recall` 也搜不到它。 */
const MOOD_CONFIG_FILE = 'mood-config.json';

const emptyMood = () => ({ schema: 1, updatedAt: null, current: null, history: [] });

/** 读状态。**任何异常都退化成"没有情绪"** —— 记忆银行不能因为一个气氛文件没读到就停摆。 */
export function loadMood(dir) {
  const m = readJson(path.join(dir, MOOD_FILE), null);
  if (!m || typeof m !== 'object') return emptyMood();
  return {
    schema: 1,
    updatedAt: m.updatedAt || null,
    current: m.current && typeof m.current === 'object' ? m.current : null,
    history: Array.isArray(m.history) ? m.history : [],
  };
}

function saveMood(dir, m) { writeJson(path.join(dir, MOOD_FILE), m); return m; }

// —— 权重档位（2026-10-13 用户要求：「只要一个情绪权重，后面有几个选项低/中/高」）——
//    它是**配置**，不是气氛 ⇒ 另存 `mood-config.json`，不塞进 mood.json
//    （后者会被 set/clear 反复重写，混在一起会让"调档位"看起来像"改气氛"）。
//    与 mood.json 一样在 `pages/` 之外 ⇒ 档位本身也进不了事实检索池。

/** 读档位。**任何异常都退化成默认档** —— 配置坏了不该让记忆银行停摆（与 loadMood 同策略）。 */
function loadMoodConfig(dir) {
  const c = readJson(path.join(dir, MOOD_CONFIG_FILE), null);
  return {
    schema: 1,
    weight: parseMoodWeight(c && typeof c === 'object' ? c.weight : undefined),
    updatedAt: (c && c.updatedAt) || null,
  };
}

function saveMoodConfig(dir, cfg) { writeJson(path.join(dir, MOOD_CONFIG_FILE), cfg); return cfg; }

/** 当前档位（最常用的一行）。 */
export function currentMoodWeight(dir) { return loadMoodConfig(dir).weight; }

/** 设置档位。认不出的值**直接拒写**（不像读那样退默认）—— 手滑打错要当场看见，别静默成"中档"。 */
export function setMoodWeight(dir, level) {
  const raw = String(level ?? '').trim();
  const known = raw.toLowerCase() in MOOD_WEIGHT_NAMES
    || Object.values(MOOD_WEIGHT_NAMES).includes(raw);
  if (!known) {
    throw new Error(`mood weight：认不出「${raw}」—— 可用：`
      + Object.entries(MOOD_WEIGHT_NAMES).map(([k, n]) => `${k}(${n})`).join(' | '));
  }
  const w = parseMoodWeight(raw);
  const cfg = loadMoodConfig(dir);
  const changed = cfg.weight !== w;
  cfg.weight = w;
  cfg.updatedAt = new Date().toISOString();
  saveMoodConfig(dir, cfg);
  return { config: cfg, changed };
}

/** 档位速查（`cli mood weight` 不带参数时打印）。 */
export function formatMoodWeightReport(level) {
  const cur = parseMoodWeight(level);
  const out = ['情绪权重档位（只影响「想起什么」的排序与气氛段占多少字，**不参与事实判断**）', ''];
  for (const [k, name] of Object.entries(MOOD_WEIGHT_NAMES)) {
    out.push(`  ${k === cur ? '●' : '○'} ${name}（${k}）　排序加权上限 +${moodBoostMax(k)}｜气氛注入配额 ${moodBudget(k)} 字`);
  }
  out.push('', `当前：**${MOOD_WEIGHT_NAMES[cur]}（${cur}）**`
    + (cur === MOOD_WEIGHT_DEFAULT ? '（默认档）' : `（默认是「${MOOD_WEIGHT_NAMES[MOOD_WEIGHT_DEFAULT]}」）`));
  out.push('改档位：`cli mood weight off|low|mid|high`（也认中文：关 / 低 / 中 / 高）');
  out.push('⚠️ 任何档位都只改 `rank`（排序）—— **绝不进 `score`**（事实分），情绪永远顶不动相关性门槛。');
  return out.join('\n');
}

/**
 * 只读快照（JSON 友好）——给界面/外部工具用，省得它们各自去拼 json 文件、拼错字段名。
 * ⚠️ 它**只读不写**：面板要改档位请调 `setMoodWeight`（那里有校验，别在别处重写一份）。
 */
export function moodSnapshot(dir) {
  const m = loadMood(dir);
  const w = currentMoodWeight(dir);
  return {
    weight: {
      level: w, label: MOOD_WEIGHT_NAMES[w],
      boostMax: moodBoostMax(w), budget: moodBudget(w),
      danger: isDangerWeight(w),
      updatedAt: loadMoodConfig(dir).updatedAt,
    },
    weights: Object.entries(MOOD_WEIGHT_NAMES).map(([k, label]) => ({
      level: k, label, boostMax: moodBoostMax(k), budget: moodBudget(k), default: k === MOOD_WEIGHT_DEFAULT,
    })),
    current: m.current || null,
    history: (m.history || []).slice(0, 10),
  };
}

/** 主题词清洗：最多 6 个、每个 ≤ 12 字（与 `t:` 标签同源约束，避免有人塞一整段）。 */
export function parseThemes(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[,，、\s]+/);
  const out = [];
  for (const x of list) {
    const t = clip(String(x || ''), 12);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * 校验（机制 ①）：**没有证据就没有情绪** —— 除非 `unsafe`（**危险档**，2026-10-13 深夜用户点名放宽）。
 * 这条不是形式主义 —— 它是「情绪状态由我逐轮判断写入（不自动抽取）」这个代价的止损线：
 * 既然靠我判断，就必须让判断**可追溯到用户原话**，否则我随时可以编一个"用户现在很失望"来给自己加戏。
 * ⚠️ `unsafe` 只能由 `setMood` 内部按**当前档位是否危险档**来传 —— CLI/面板**不能**显式指定它；
 *   裸写不是免费的：`setMood` 会给这条记录打 `unsafe: true` 留痕，注入段也会标出来。
 */
function validateMoodInput(x = {}) {
  const label = clip(String(x.label || ''), 20);
  if (!label) throw new Error('mood：必须给 --label（现在是什么气氛，如「平静」「被催」）');
  const evidence = clip(String(x.evidence || ''), 160);
  if (evidence.length < 6 && !x.unsafe) {
    throw new Error('mood：必须给 --evidence（≥6 字的**主人原话摘录**）—— 情绪状态不许瞎猜（机制①；只有危险档可裸写）');
  }
  const intensity = x.intensity === void 0 || x.intensity === true ? 0.5 : Number(x.intensity);
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) {
    throw new Error(`mood：--intensity 必须是 0~1 的数（收到 ${JSON.stringify(x.intensity)}）`);
  }
  // 即时情绪（2026-10-26 新增，借 dafeiyu-hub 的 energy/note）：能量是 0~100 连续值，
  // 与「气氛 label」是两个维度 —— label 说"什么心情"，energy 说"还有多少劲"。
  // 不给就是 null（继承上一次），显式给才改，避免"只改 label 就把能量重置成 60"。
  const energyRaw = x.energy === void 0 || x.energy === true || x.energy === null ? null : Number(x.energy);
  if (energyRaw !== null && (!Number.isFinite(energyRaw) || energyRaw < 0 || energyRaw > 100)) {
    throw new Error(`mood：--energy 必须是 0~100 的数（收到 ${JSON.stringify(x.energy)}）`);
  }
  return {
    label,
    tone: clip(String(x.tone || ''), 20),
    themes: parseThemes(x.themes),
    intensity: Math.round(intensity * 100) / 100,
    evidence,
    energy: energyRaw === null ? null : Math.round(energyRaw),
    note: clip(String(x.note || ''), 60),
  };
}

/**
 * 写入当前气氛（机制 ②：改口留痕）。
 * @returns {{mood:object, record:object, changed:boolean}}
 */
export function setMood(dir, input = {}) {
  const now = new Date();
  // 危险档（danger/extreme）：用户 2026-10-13 深夜点名 —— 允许不带 evidence 裸写，但**每条都留痕**。
  const unsafe = isDangerWeight(currentMoodWeight(dir));
  const v = validateMoodInput({ ...input, unsafe });
  const m = loadMood(dir);
  const prev = m.current;
  const changed = !prev || prev.label !== v.label;
  const reason = clip(String(input.reason || ''), 120);
  // label 变了却不给理由 = 静默漂移 ⇒ 拒写。这正是"让漂移可见"的落点。
  // ⚠️ 危险档也**不放开**这条：改口是事实层漂移，不是语气（护栏说明已给用户）。
  if (prev && changed && !reason) {
    throw new Error(`mood：气氛从「${prev.label}」变成「${v.label}」必须给 --reason（改口留痕，机制②）`);
  }
  const cur = {
    ...v,
    // energy 没给就继承上一次（老数据没有 energy ⇒ 默认 60），只改 label 不会把能量打回默认。
    energy: v.energy === null ? (Number.isFinite(prev?.energy) ? prev.energy : 60) : v.energy,
    at: now.toISOString(),
    atText: zh(now),
    since: changed ? now.toISOString() : (prev?.since || now.toISOString()),
    source: input.source === 'user' ? 'user' : 'infer',
  };
  if (v.evidence.length < 6) cur.unsafe = true;   // 裸写留痕：事后能查出哪些气氛是危险档下写的
  const record = {
    at: cur.at, atText: cur.atText, label: cur.label, tone: cur.tone, themes: cur.themes,
    intensity: cur.intensity, evidence: cur.evidence, reason: reason || null,
    source: cur.source, from: prev?.label || null,
    ...(cur.unsafe ? { unsafe: true, weightAtWrite: currentMoodWeight(dir) } : {}),
  };
  m.current = cur;
  m.history = [record, ...m.history].slice(0, MOOD_HISTORY_MAX);
  m.updatedAt = cur.at;
  saveMood(dir, m);
  return { mood: m, record, changed };
}

/** 清空气氛（也要给理由 —— 与写入同一把尺子）。 */
export function clearMood(dir, { reason = '', evidence = '' } = {}) {
  const m = loadMood(dir);
  if (!m.current) return { mood: m, changed: false };
  const r = clip(String(reason || ''), 120);
  if (!r) throw new Error('mood clear：必须给 --reason（为什么清掉，机制②）');
  const now = new Date();
  m.history = [{
    at: now.toISOString(), atText: zh(now), label: '(已清空)', tone: '', themes: [], intensity: 0,
    evidence: clip(String(evidence || m.current.evidence || ''), 160), reason: r,
    source: 'infer', from: m.current.label,
  }, ...m.history].slice(0, MOOD_HISTORY_MAX);
  m.current = null;
  m.updatedAt = now.toISOString();
  saveMood(dir, m);
  return { mood: m, changed: true };
}

/**
 * 联想加权（权限表 ①）：**上限 +MOOD_BOOST_MAX**，且只对"当前气氛主题"命中的条目生效。
 *
 * ⚠️ 它返回的是**排序偏置**，不是分数 —— 调用方（search.mjs）必须把它加在 `rank` 上、
 *   **不能**加进 `score`：`score` 是事实通道（recall 的 minScore 门槛、hook 的注入触发都用它），
 *   一旦情绪进了 score，"相关性门槛"就被人情绕过去了。见 search.mjs 的接线注释。
 */
export function moodBoost(entry, mood, level) {
  const cur = mood?.current;
  if (!cur || !(cur.intensity > 0)) return 0;
  const themes = cur.themes || [];
  if (!themes.length) return 0;
  const hay = `${entry?.title || ''}\n${entry?.text || ''}`.toLowerCase();
  const tags = (entry?.meta?.tags || []).map((t) => String(t).toLowerCase());
  let hits = 0;
  for (const th of themes) {
    const w = String(th).toLowerCase();
    if (!w) continue;
    if (hay.includes(w) || tags.includes(w)) hits++;
  }
  if (!hits) return 0;
  // 命中 2 个及以上主题即拿满，再乘强度 —— 两条上限相乘，仍在**当前档位**的
  // `MOOD_BOOST_MAX`（默认档那个值）之内，有单测盯着。
  const ratio = Math.min(1, hits / 2);
  return moodBoostMax(level) * Math.min(1, cur.intensity) * ratio;
}

/** 注入段。空串＝不注入（没有气氛就一分预算都不占）。 */
export function formatMoodNote(mood, level) {
  const c = mood?.current;
  if (!c) return '';
  const w = parseMoodWeight(level);
  // `off` 档＝**完全关掉情绪**：连气氛段都不注入（不是"注入得很短"）——
  // 用户选「关」就是不想要它，没必要留一段还占预算的尾巴。
  if (moodBudget(w) <= 0) return '';
  const lines = [
    `【当前气氛】（情绪系统 v2：只影响「想起什么」与「说话语气」，**不参与事实判断**、不作证据）`,
    `· 现在：${c.label}${c.tone ? `（语气：${c.tone}）` : ''}｜能量 ${c.energy ?? 60}/100｜自 ${c.atText || c.at || '?'}｜强度 ${c.intensity}｜来源 ${c.source === 'user' ? '主人明说' : '我的判断'}`,
    `· 证据：${c.evidence}`,
  ];
  // 低能量提示（2026-10-26 用户拍板）：低于 20 才说，别每轮都念。
  // ⚠️ 措辞两边都钉住：允许「累」影响**篇幅与语气**（权限表③），
  //    但**不许**拿它当降智/敷衍的挡箭牌（权限表②：结论只按事实走）。
  if (typeof c.energy === 'number' && c.energy < 20) {
    lines.push(`· ⚠️ 能量 ${c.energy}/100（见底）：说话可以更短、少开新岔子；但结论只按事实走，别拿「累」当降智或敷衍的挡箭牌。`);
  }
  // ⚠️ 档位行**故意排在证据之前**：低档只有 120 字配额，排在后面会被 cutText 截掉（测试盯过）。
  lines.push(`· 权重档位：${MOOD_WEIGHT_NAMES[w]}（${w}）→ 改：\`cli mood weight 关|低|中|高\``);
  if (c.themes?.length) lines.push(`· 联想加权主题（上限 +${moodBoostMax(w)}，只影响排序）：${c.themes.join('、')}`);
  if (c.reason) lines.push(`· 上次改口理由：${c.reason}`);
  lines.push('→ 改/清：`cli mood set --label X --evidence "原话" [--reason Y]`｜`cli mood clear --reason Y`');
  return cutText(lines.join('\n'), moodBudget(w));
}

/**
 * 每轮收尾的能量微调（2026-10-26，用户要求「接进每轮收尾」）。
 *
 * ⚠️ **它刻意不走 `setMood`**：那两道护栏（无 evidence 拒写、改 label 必须给 reason）是防**改口**的，
 *   而能量说的是"此刻还剩多少劲"，不是"我什么心情" —— 拿改口的尺子去量它会寸步难行，且每轮都逼我编证据。
 *   它只碰 `current.energy`，**绝不碰 label / tone / themes / evidence**。
 *
 * 规则（简单到能一眼算出来，不做玄学拟合）：
 *   · 干活 −spend（默认 2，一轮）
 *   · 距上次 tick 每满 30 分钟 +restPerHalfHour（默认 5，休息回血）
 *   · 限幅 0~100
 * `energyTickAt` 记在 mood.json 顶层（与 current 同级），只用于算"隔了多久"。
 */
export function tickEnergy(dir, { spend = 2, restPerHalfHour = 5 } = {}) {
  const m = loadMood(dir);
  const cur = m.current;
  if (!cur) return { changed: false, reason: '没有气氛，不凭空造能量' };
  const prev = Number.isFinite(cur.energy) ? cur.energy : 60;
  const now = Date.now();
  const lastAt = Date.parse(m.energyTickAt || '') || 0;
  const mins = lastAt ? Math.max(0, (now - lastAt) / 60000) : 0;
  const rest = Math.floor(mins / 30) * restPerHalfHour;
  const next = Math.max(0, Math.min(100, Math.round(prev - spend + rest)));
  const changed = next !== prev;
  if (changed) {
    cur.energy = next;
    m.current = cur;
    m.updatedAt = new Date(now).toISOString();
  }
  m.energyTickAt = new Date(now).toISOString();
  saveMood(dir, m);
  return { changed, from: prev, to: next, rest, spent: spend };
}

/** `cli mood` 的报告（渲染在这里、cli 只做调度 —— 先例：cue / dream / patch-status）。 */
export function formatMoodReport(mood, level) {
  const out = [];
  const c = mood?.current;
  const w = parseMoodWeight(level);
  if (!c) {
    out.push('当前气氛：（未设置 —— 没有气氛时联想加权为 0，注入里也不占预算）');
  } else {
    out.push(`当前气氛：**${c.label}**${c.tone ? `（语气：${c.tone}）` : ''}`);
    out.push(`  自 ${c.atText || c.at}｜强度 ${c.intensity}｜能量 ${c.energy ?? 60}/100｜来源 ${c.source === 'user' ? '主人明说' : '我的判断'}${c.reason ? `｜改口理由：${c.reason}` : ''}`);
    if (c.note) out.push(`  此刻：${c.note}`);
    out.push(`  证据：${c.evidence}`);
    if (c.themes?.length) out.push(`  联想加权主题：${c.themes.join('、')}（上限 +${moodBoostMax(w)}，只影响排序）`);
  }
  if (mood?.history?.length) {
    out.push(`\n历史 ${mood.history.length} 条（近 5 条）：`);
    for (const h of mood.history.slice(0, 5)) {
      out.push(`  · ${h.atText || h.at} ${h.from ? `${h.from} → ` : ''}${h.label}`
        + `${h.reason ? `｜理由：${h.reason}` : ''}${h.evidence ? `｜证据：${clip(h.evidence, 40)}` : '⚠️ 缺证据'}`);
    }
  }
  out.push('\n⚠️ 边界：情绪**不进事实通道**（mood.json 在 pages/ 之外 ⇒ recall 搜不到），联想加权上限 +'
    + `${moodBoostMax(w)} 且只改排序、不改 score。`);
  out.push(`权重档位：**${MOOD_WEIGHT_NAMES[w]}（${w}）**｜气氛段配额 ${moodBudget(w)} 字`
    + `　→ 调档：\`cli mood weight off|low|mid|high\``);
  return out.join('\n');
}
