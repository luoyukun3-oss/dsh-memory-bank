// ============================================================================
// Memory Bank · mood-render —— 情绪的**出口**（2026-11-09 从 mood.mjs 按域拆出）
//   为什么拆：同 mood-weight（mood.mjs 349/360 逼近红线）。
//   本文件只装三个纯函数：联想排序偏置（moodBoost）、注入段（formatMoodNote）、
//   CLI 报告（formatMoodReport）—— 全都**只读**状态、不写盘、不改事实。
//   ⚠️ 权限表在这里最容易被破坏：`moodBoost` 返回的是**排序偏置**，调用方必须把它加在 `rank`、
//      绝不能加进 `score`（score 是事实通道，见 search.mjs 的接线注释）。
//   ⚠️ 对外零变化：mood.mjs 用 `export { ... } from "./mood-render.mjs"` 转发。
// ============================================================================
import { clip, cutText } from './core.mjs';
import {
  MOOD_WEIGHT_NAMES, moodBoostMax, moodBudget, parseMoodWeight,
} from './config-keys.mjs';

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
