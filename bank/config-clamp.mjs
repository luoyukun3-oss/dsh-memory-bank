// ============================================================================
// Memory Bank · config-clamp —— 配置键的「值域声明 + 夹紧」（2026-11-08）
//
// 为什么要有它：`config-keys.mjs` 是单一真相源，但**只有值、没有合法区间** —— 有人把某个预算
//   写成 -5 或 100000，`test.mjs` 照样全绿（它只查「登记覆盖」，没有一条查区间）。
//
// 三条设计铁律：
//   ① **区间依据必须来自代码实际用法或注释**，不许凭空拍。拿不准的键宁可不声明（报告里列出）。
//   ② **夹紧是恒等的**：当前所有键的现值都落在区间内 ⇒ 夹紧后一个字节都不变
//      （由 `test-config-clamp.mjs` 断言，防止"区间拍错了把正常值判越界"）。
//   ③ 本文件只**声明与校验**，绝不改写 `config-keys.mjs` 的导出值 —— 值仍只在那里定义。
//
// ⚠️ `INJECT_MIN_SCORE` **刻意不在这里**：它是绝对值、标度跟着索引规模漂，已有专属守护
//   （test.mjs 的阈值标定节：余量 <1.3× 或相关触发 <14/18 即红），区间会与那套标定打架。
// ============================================================================
import * as CK from './config-keys.mjs';

/**
 * 标量数值键的合法区间。`fallback` = 值不可用时的兜底（**等于当前标定值**，不另造新数）。
 * `why` 写依据：凡标「⚠️判断」的是设计取舍，不是实测；其余都来自消费点代码或标定注释。
 */
export const RANGES = {
  // 下界 4000 = 三段核心配额之和（全局偏好 1750 + 教训索引 1150 + 程序记忆 1100，见 bootstrap.mjs 的
  // SEG_BUDGET）；再小就只能注入偏好段。上界 32000 = 现值 4×，注入文本约占 1M 上下文的 3%（⚠️判断）。
  INJECT_BUDGET: { min: 4000, max: 32000, fallback: 8000, why: 'SEG_BUDGET 三段核心合计 4000；实测注入 7144（bootstrap.mjs:305）' },
  // 0 轮 = 关掉交接（等于删功能）；上界 10 = HANDOFF_CHARS(620) ÷ 每轮约 60~120 字，再多必被截断。
  HANDOFF_TURNS: { min: 1, max: 10, fallback: 5, why: '620 字预算装不下 10 轮以上' },
  // 下界 280 = 头尾壳约 140（bootstrap.mjs:94 注释）+ 正文兜底 120（同文件 :99 的 Math.max(120,…)）。
  // 上界 3000 远低于 INJECT_BUDGET 下界，保证交接段不会一口吃掉总预算。
  HANDOFF_CHARS: { min: 280, max: 3000, fallback: 620, why: '头尾壳 140 + 正文兜底 120 = 构造下限 260，留余量取 280' },
  DEGEN_MAX_FILES: { min: 1, max: 50, fallback: 4, why: '至少扫 1 个；全库 271 个会话文件，扫全库会慢（sweep 要快）' },
  DEGEN_WINDOW_H: { min: 1, max: 720, fallback: 48, why: '1 小时 ~ 30 天；同上，sweep 耗时（⚠️判断）' },
  FRAG_MIN_CHARS: { min: 50, max: 10000, fallback: 400, why: '判据是「思考 ≥ N 字」；太小会把正常短思考算进去' },
  FRAG_RATIO_MIN: { min: 0.01, max: 1, fallback: 0.2, why: 'fragRatio 是比例，定义域 [0,1]；0 会让任何步都命中' },
  SELF_REPEAT_MIN: { min: 2, max: 100, fallback: 10, why: '重复 ≥2 是「重复」的最小语义；标定见 config-keys 的注释（取 10 而非 8）' },
  CUE_DF_MAX: { min: 0.01, max: 0.5, fallback: 0.08, why: 'df 是比例；0.5 意味着半个库都算泛词（标定：插件 14.4% / DSH 29.9% 必须被挡）' },
  CUE_DF_MAX_OUTPUT: { min: 0.01, max: 0.5, fallback: 0.05, why: '同上；且必须 < CUE_DF_MAX（交集区间，见 test.mjs 第 26 节注释）' },
  CUE_MIN_LEN: { min: 2, max: 8, fallback: 2, why: 'test.mjs 断言单字不触发（cueWordOk("乱") === false）⇒ 下界只能是 2' },
  CUE_MAX_LEN: { min: 2, max: 100, fallback: 8, why: '与 CUE_MIN_LEN 同域比较，必须 ≥ 它' },
  CUE_MAX_LEN_CUE: { min: 2, max: 200, fallback: 30, why: '注释：cue 档比标签宽，可是一整段报错原文（空格用 + 还原）' },
  CUE_MAX_HITS: { min: 1, max: 50, fallback: 8, why: '扫多少条候选，至少 1' },
  CUE_BODY_HITS: { min: 0, max: 8, fallback: 1, why: '给正文的名额；0 = 全部只给路牌（判断权全回推理）' },
  CUE_MAX_ROADS: { min: 0, max: 20, fallback: 4, why: '路牌名额，每条约 28 字（cue-render.mjs:93）' },
  CUE_BUDGET: { min: 100, max: 2000, fallback: 320, why: 'cue-render.mjs 里 Math.max(60,…) 兜底；预算 ≈ 正文 190 + 路牌 4×28' },
  CUE_ENTRY_CHARS: { min: 40, max: 1000, fallback: 180, why: 'pickActionable 的截断长度，要装得下一句可执行结论' },
  MOOD_HISTORY_MAX: { min: 1, max: 500, fallback: 30, why: '气氛历史保留条数（mood.mjs 的 slice(0, N)）' },
};

/** `MOOD_WEIGHTS` 的嵌套区间：6 档共用同一对上下界（每档都在这个域内）。 */
export const MOOD_RANGES = {
  boost: { min: 0, max: 1, fallback: 0.15, why: '加成上限；extreme 档就是 1.00，已是设计上界' },
  budget: { min: 0, max: 480, fallback: 200, why: '段配额；danger/extreme 只加到 360（decisions.md：不靠灌字数）' },
};

/** 跨键约束：单独一条键都合法、合起来却矛盾的情况（比如路牌位比名额还多）。 */
export const CROSS_RULES = [
  { a: 'CUE_DF_MAX_OUTPUT', op: '<', b: 'CUE_DF_MAX', why: 'output 词筛必须比 prompt 更严，否则那个筛子不起作用' },
  { a: 'CUE_MIN_LEN', op: '<=', b: 'CUE_MAX_LEN', why: '下限大于上限 ⇒ cueWordOk 永远返回 false，触发式联想整体失效' },
  { a: 'CUE_MAX_LEN', op: '<=', b: 'CUE_MAX_LEN_CUE', why: 'cue 档按设计比标签宽' },
  { a: 'CUE_BODY_HITS', op: '<=', b: 'CUE_MAX_HITS', why: '正文名额不能超过扫出来的候选数' },
];

/** 数值夹紧：非数字/空/NaN ⇒ `fallback`；越界 ⇒ 夹到边界。`clamp(clamp(x)) === clamp(x)`。 */
export function clampNum(v, min, max, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
export const clampInt = (v, min, max, fallback) => Math.round(clampNum(v, min, max, fallback));

/** 按键名取当前值（标量键直接取；`MOOD_WEIGHTS.a.b` 这种点路径逐层取）。 */
function valueOf(key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), CK);
}

/**
 * 体检：每一项 `{key, value, min, max, ok}`。`ok === false` 就说明「有人把键改到了区间外」。
 * 覆盖三类：标量键（RANGES）、情绪档位（MOOD_WEIGHTS 展平成 6×2）、跨键约束（CROSS_RULES）。
 */
export function checkConfig() {
  const out = [];
  for (const [key, r] of Object.entries(RANGES)) {
    const value = valueOf(key);
    const ok = typeof value === 'number' && Number.isFinite(value) && value >= r.min && value <= r.max;
    out.push({ key, value, min: r.min, max: r.max, ok });
  }
  for (const [level, w] of Object.entries(CK.MOOD_WEIGHTS || {})) {
    for (const [field, r] of Object.entries(MOOD_RANGES)) {
      const value = w?.[field];
      const ok = typeof value === 'number' && Number.isFinite(value) && value >= r.min && value <= r.max;
      out.push({ key: `MOOD_WEIGHTS.${level}.${field}`, value, min: r.min, max: r.max, ok });
    }
  }
  for (const c of CROSS_RULES) {
    const va = valueOf(c.a), vb = valueOf(c.b);
    const ok = c.op === '<' ? va < vb : va <= vb;
    out.push({ key: `${c.a} ${c.op} ${c.b}`, value: `${va} ${c.op} ${vb}`, min: null, max: null, ok });
  }
  return out;
}
