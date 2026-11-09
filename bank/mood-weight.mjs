// ============================================================================
// Memory Bank · mood-weight —— 情绪**权重档位**（2026-11-09 从 mood.mjs 按域拆出）
//   为什么拆：mood.mjs 实测 349/360 行（97%，逼近红线）。按预算表规矩「先按域拆、别压行宽」。
//   本文件只装**档位这一层配置**：off/low/mid/high 的读写与校验报告。
//   ⚠️ 它是**配置**、不是气氛 ⇒ 存 `mood-config.json`，与 mood.json 分开（见 mood.mjs 的说明）。
//   ⚠️ 对外零变化：mood.mjs 用 `export { ... } from "./mood-weight.mjs"` 转发。
// ============================================================================
import path from 'node:path';
import { readJson, writeJson } from './core.mjs';
import {
  MOOD_WEIGHT_DEFAULT, MOOD_WEIGHT_NAMES, moodBoostMax, moodBudget, parseMoodWeight,
} from './config-keys.mjs';

/** 权重档位的存放文件。与 `mood.json` 同级 ⇒ 同样落在 `pages/` 之外 ⇒ `recall` 也搜不到它。 */
const MOOD_CONFIG_FILE = 'mood-config.json';

// —— 权重档位（2026-10-13 用户要求：「只要一个情绪权重，后面有几个选项低/中/高」）——
//    它是**配置**，不是气氛 ⇒ 另存 `mood-config.json`，不塞进 mood.json
//    （后者会被 set/clear 反复重写，混在一起会让"调档位"看起来像"改气氛"）。
//    与 mood.json 一样在 `pages/` 之外 ⇒ 档位本身也进不了事实检索池。

/** 读档位。**任何异常都退化成默认档** —— 配置坏了不该让记忆银行停摆（与 loadMood 同策略）。
 *  ⚠️ 导出但**不由 mood.mjs 再转发**：它是给 mood.mjs 内部（moodSnapshot 要 updatedAt）用的。 */
export function loadMoodConfig(dir) {
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
