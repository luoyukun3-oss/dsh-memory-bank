// ============================================================================
// graph-edit-lib —— 「连边指令」的**唯一实现**（2026-11-09）
//
// 为什么单独一个文件（而不是直接在 graph-render.mjs 里写页面 JS）：
//   页面里那段 JS 是**字符串模板**，Node 侧测不到它；而不测就等于"看起来能点、
//   生成的指令却没验证过"。这里的做法是：**一套源码、两处执行** ——
//     · `graph-render.mjs` 把 `EDIT_LIB_SRC` 原样内联进 graph.html（浏览器里跑）
//     · `bank/test-graph-edit.mjs` 用 `new Function` 把同一份源码求值（Node 里断言）
//   ⇒ 不存在「页面一份、测试一份」的双实现漂移（assoc.mjs 当年就是两份实现各跑各的）。
//
// ⚠️ `EDIT_LIB_SRC` 里的代码只能用**浏览器和 Node 都有**的语法：不许 import、不许反引号
//   模板字符串（它本身嵌在模板字符串里）、不许用 Node 专有 API。参数全部显式传入。
//
// 关系类型**不硬编码**：从 `bank/core.mjs` 的 `REL_TYPES` 取 —— 那是 parseMeta 判定类型的
// 白名单（`rel:页:关键词:类型`，末段命中白名单才算类型）。自己抄一份就等着漂移。
// ============================================================================
import { REL_TYPES } from '../bank/core.mjs';

/** 合法的关系类型（顺序固定，页面按这个顺序出按钮；与 core.mjs 同源）。 */
export const EDIT_REL_TYPES = [...REL_TYPES];

/** 每种类型的含义（只用于页面提示，不参与校验；取自 core.mjs 注释的 Ariadne 7 类边）。 */
export const EDIT_REL_TYPE_HINTS = {
  causal: '因果：A 导致 / 引起 B',
  sequence: '顺序：A 在前，B 在后',
  scenario: '同场景：同一件事的两个落点',
  attribute: '属性：B 是 A 的属性 / 细节',
  preference: '偏好：B 是主人对 A 的态度',
  social: '人际：涉及具体的人',
  temporal: '时间：发生在同一段时间',
};

// —— 下面这段源码会被**两处**执行（页面内联 / Node 里 new Function）——
export const EDIT_LIB_SRC = [
  'function gerelNorm(id) { return String(id == null ? \'\' : id).trim(); }',
  // 条目 id 的形态就是 index.json 里的 `页名#序号`（rel-apply.mjs 用的也是这个）
  'function gerelIsItemId(id) { return /^[^\\s#]+\\.md#\\d+$/.test(gerelNorm(id)); }',
  'function gerelPageOf(id) { return gerelNorm(id).split(\'#\')[0]; }',
  // 同一对（不分方向）的指纹：rel 是**双向写**的（rel-apply 给两端都写），所以 A→B 与 B→A 是同一件事
  'function gerelPairKey(a, b) { return [gerelNorm(a), gerelNorm(b)].sort().join(\'|\'); }',
  'function gerelValidatePair(a, b) {',
  '  var x = gerelNorm(a), y = gerelNorm(b);',
  '  if (!x || !y) return { ok: false, why: \'两个节点都要先选中\' };',
  '  if (x === y) return { ok: false, why: \'自连不成立：两端是同一条\' };',
  '  if (!gerelIsItemId(x) || !gerelIsItemId(y)) return { ok: false, why: \'id 不是「页#序号」形态：\' + x + \' / \' + y };',
  '  return { ok: true, why: \'\' };',
  '}',
  // 从「点选清单」生成 rel-apply 吃的 verdicts：去重（含反向）、丢掉非法项并**说明原因**（不静默）
  'function gerelMakeVerdicts(pairs, types) {',
  '  var out = [], dropped = [], seen = {};',
  '  var list = pairs || [], ok = types || [];',
  '  for (var i = 0; i < list.length; i++) {',
  '    var p = list[i] || {};',
  '    var v = gerelValidatePair(p.a, p.b);',
  '    if (!v.ok) { dropped.push({ a: p.a, b: p.b, why: v.why }); continue; }',
  '    var k = gerelPairKey(p.a, p.b);',
  '    if (seen[k]) { dropped.push({ a: p.a, b: p.b, why: \'重复：这一对已经在清单里\' }); continue; }',
  '    seen[k] = 1;',
  '    var t = p.type && ok.indexOf(p.type) >= 0 ? p.type : null;',
  '    var item = { a: gerelNorm(p.a), b: gerelNorm(p.b), verdict: \'yes\' };',
  '    if (t) item.type = t;',
  '    out.push(item);',
  '  }',
  '  return { verdicts: out, dropped: dropped };',
  '}',
  // 生成可直接粘贴运行的命令（rel-apply 是既有入口，默认干跑，--apply 才真写）
  'function gerelQuote(s) { return \'"\' + String(s == null ? \'\' : s).replace(/"/g, \'\\\\"\') + \'"\'; }',
  'function gerelMakeCommand(toolPath, jsonPath, repoPath) {',
  '  var j = gerelNorm(jsonPath) || \'<把下载的 JSON 路径填这里>\';',
  '  var c = \'node \' + gerelQuote(toolPath) + \' \' + gerelQuote(j) + \' --apply\';',
  '  if (gerelNorm(repoPath)) c += \' --repo \' + gerelQuote(repoPath);',
  '  return c;',
  '}',
].join('\n');

/** Node 侧的同一份实现（`new Function` 求值，保证与页面逐字一致）。 */
export const EDIT_LIB = new Function(`${EDIT_LIB_SRC}\nreturn { gerelNorm, gerelIsItemId, gerelPageOf, gerelPairKey, gerelValidatePair, gerelMakeVerdicts, gerelMakeCommand };`)();
