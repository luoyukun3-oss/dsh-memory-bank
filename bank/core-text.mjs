// ============================================================================
// Memory Bank · core-text —— 纯字符串工具（2026-11-09 从 core.mjs 按域拆出）
//   为什么拆：同 core-transcript（core.mjs 509/510 逼近红线，按域拆而非压行宽）。
//   本文件装**不碰文件系统、不碰业务**的文本件：指纹归一 / 停用词与噪音判定 /
//   流水行剥离 / 按行边界截断 / 章节切分 / MEMORY↔页的章节映射 / 行级差异 / 页块识别。
//   ⚠️ 对外**零变化**：core.mjs 用 `export { ... } from "./core-text.mjs"` 原样转发。
//   ⚠️ 纯函数、零依赖 ⇒ 测试可直接单点验证，不必建临时库。
// ============================================================================

export function fingerprint(s) {
  return String(s || '')
    .replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

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
