// ============================================================================
// Memory Bank · test-config-clamp —— 值域声明与夹紧的守护（2026-11-08）
//
// 为什么单独一个文件：`test.mjs` 不许改（Lead 统一收口），而这条守护要能独立跑：
//   `node -e "import('./test-config-clamp.mjs').then(m=>m.runConfigClampTests({ok:(c,l)=>console.log(c?'OK':'FAIL',l)}))"`
//
// 守四件事：
//   ① **现值全部在区间内** —— 防「区间拍错了，把正常值判成越界」；
//   ② **夹紧是恒等的** —— 防「区间拍窄了，夹一下就把标定值改了」；
//   ③ **注释里的区间 == RANGES 里的区间** —— 纸面约定挡不住漂移，只有断言能；
//   ④ **新增数值键必须来 RANGES 登记** —— 否则将来一个 -5 的预算照样全绿。
// ============================================================================
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RANGES, MOOD_RANGES, CROSS_RULES, clampInt, clampNum, checkConfig } from './config-clamp.mjs';
import * as CK from './config-keys.mjs';

/** 刻意不进 RANGES 的键：`INJECT_MIN_SCORE` 是绝对值、标度跟着索引规模漂，另有专属标定守护。 */
const EXEMPT = ['INJECT_MIN_SCORE'];

export function runConfigClampTests({ ok }) {
  console.log('== 38. 数值配置键的值域声明与夹紧（2026-11-08，防「-5 / 100000」这类数量级错误） ==');
  const src = fs.readFileSync(fileURLToPath(new URL('./config-keys.mjs', import.meta.url)), 'utf8');

  // —— ① 每个声明的键都真在 config-keys.mjs 里，且是有限数字 ——
  for (const key of Object.keys(RANGES)) {
    const v = CK[key];
    ok(typeof v === 'number' && Number.isFinite(v), `RANGES 的键 ${key} 在 config-keys.mjs 里是有限数字（实得 ${JSON.stringify(v)}）`);
  }

  // —— ② 现值全部落在区间内（这条是「区间有没有拍错」的自检）——
  const rows = checkConfig();
  const bad = rows.filter((r) => !r.ok);
  ok(rows.length >= 30, `checkConfig 覆盖 ${rows.length} 项（19 标量 + 6 档 ×2 + ${CROSS_RULES.length} 条跨键约束）`);
  ok(bad.length === 0, '所有键的现值都在声明区间内', bad.map((b) => `${b.key}=${JSON.stringify(b.value)} 不在 [${b.min},${b.max}]`).join('; '));

  // —— ③ 夹紧是恒等的：拿现值再夹一次，必须一个字节都不变 ——
  const changed = [];
  for (const [key, r] of Object.entries(RANGES)) {
    const v = CK[key];
    const c = Number.isInteger(v) ? clampInt(v, r.min, r.max, r.fallback) : clampNum(v, r.min, r.max, r.fallback);
    if (c !== v) changed.push(`${key}: ${v} → ${c}`);
  }
  ok(changed.length === 0, '夹紧对全部标量键是恒等的（现值不变）', changed.join('; '));
  const moodChanged = [];
  for (const [level, w] of Object.entries(CK.MOOD_WEIGHTS)) {
    for (const [f, r] of Object.entries(MOOD_RANGES)) {
      const c = clampNum(w[f], r.min, r.max, r.fallback);
      if (c !== w[f]) moodChanged.push(`MOOD_WEIGHTS.${level}.${f}: ${w[f]} → ${c}`);
    }
  }
  ok(moodChanged.length === 0, '夹紧对情绪档位（6 档 × boost/budget）也是恒等的', moodChanged.join('; '));

  // —— ④ 坏值：NaN / 负数 / 超大 / 字符串 / null / undefined / 空串 ——
  const B = { min: 4000, max: 32000, fallback: 8000 };
  ok(clampInt(NaN, B.min, B.max, B.fallback) === 8000, 'NaN ⇒ 回退兜底值');
  ok(clampInt(-5, B.min, B.max, B.fallback) === 4000, '负数 ⇒ 夹到下界');
  ok(clampInt(1e9, B.min, B.max, B.fallback) === 32000, '超大数 ⇒ 夹到上界');
  ok(clampInt('abc', B.min, B.max, B.fallback) === 8000, '非数字字符串 ⇒ 回退兜底值');
  ok(clampInt(null, B.min, B.max, B.fallback) === 8000, 'null ⇒ 回退兜底值');
  ok(clampInt(undefined, B.min, B.max, B.fallback) === 8000, 'undefined ⇒ 回退兜底值');
  ok(clampInt('', B.min, B.max, B.fallback) === 8000, '空串 ⇒ 回退兜底值（不是被 Number("") 当成 0）');
  ok(clampInt('9000', B.min, B.max, B.fallback) === 9000, '数字字符串被宽容接受');
  ok(clampInt(3999.6, B.min, B.max, B.fallback) === 4000, '小数按四舍五入后夹住');
  ok(clampNum(0.0001, 0.01, 0.5, 0.05) === 0.01, 'clampNum 下界夹紧（小数键不走取整）');
  ok(clampNum(Infinity, 0.01, 0.5, 0.05) === 0.05, 'Infinity ⇒ 回退兜底值（不是夹到上界）');

  // —— ⑤ 幂等：clamp(clamp(x)) === clamp(x) ——
  const seq = [NaN, -1e9, -1, 0, 1, 3999.9, 8000, 31999, 32000, 1e9, 'abc', null, undefined, '', '9000', Infinity];
  const idem = [];
  for (const [key, r] of Object.entries(RANGES)) {
    for (const x of seq) {
      const once = clampNum(x, r.min, r.max, r.fallback);
      const twice = clampNum(once, r.min, r.max, r.fallback);
      if (once !== twice) idem.push(`${key}(${String(x)}): ${once} → ${twice}`);
    }
  }
  ok(idem.length === 0, `夹紧幂等（${Object.keys(RANGES).length} 键 × ${seq.length} 个输入，重夹不再变）`, idem.slice(0, 3).join('; '));

  // —— ⑥ 注释里的区间 == RANGES（防注释与真值漂移）——
  const inComment = {};
  for (const m of src.matchAll(/export const (\w+) = -?[\d.]+;[^\n]*?区间 \[(-?[\d.]+),\s*(-?[\d.]+)\]/g)) {
    inComment[m[1]] = [Number(m[2]), Number(m[3])];
  }
  const drift = [];
  for (const [key, r] of Object.entries(RANGES)) {
    const c = inComment[key];
    if (!c) { drift.push(`${key} 没写注释区间`); continue; }
    if (c[0] !== r.min || c[1] !== r.max) drift.push(`${key} 注释 [${c}] ≠ RANGES [${r.min},${r.max}]`);
  }
  ok(drift.length === 0, `config-keys.mjs 的 ${Object.keys(RANGES).length} 条行尾「区间 [...]」与 RANGES 逐条一致`, drift.join('; '));

  // —— ⑦ 新增数值键必须来登记（否则将来一个 -5 的预算照样全绿）——
  const numericExports = [...src.matchAll(/^export const (\w+) = -?[\d.]+;/gm)]
    .map((m) => m[1])
    .filter((k) => !EXEMPT.includes(k));
  const undeclared = numericExports.filter((k) => !(k in RANGES));
  ok(numericExports.length >= 18, `扫到 ${numericExports.length} 个数值型 export（豁免 ${EXEMPT.length} 个）`);
  ok(undeclared.length === 0, '每个数值型 export 都在 RANGES 里登记了区间（没有漏网的）', undeclared.join(', '));

  // —— ⑧ 跨键约束（单独一条合法、合起来矛盾）——
  const crossBad = rows.filter((r) => r.min === null && !r.ok);
  ok(crossBad.length === 0, `${CROSS_RULES.length} 条跨键约束成立`, crossBad.map((b) => b.key).join('; '));
}
