/**
 * 零依赖红线：bank/（含 hooks/）下所有 .mjs 只允许两类 import 目标 ——
 *   ① Node 内置模块（`node:` 前缀）
 *   ② 同仓库相对路径（`./` 或 `../`）
 * 裸包名（lodash / chalk 之流）、`file://` 绝对 URL、`http(s):` 一律判红。
 *
 * 为什么当红线而不是偏好：记忆银行要在 DSH 的受限沙箱里跑 hook
 * （SessionStart / UserPromptSubmit）—— 一旦引入第三方依赖，宿主没装、
 * 或 node_modules 不在解析路径上，hook 会**静默失败**，表现为「注入莫名消失」，
 * 比直接报错难查得多。零依赖同时保证换机器、换目录即用
 * （本轮就是把 test.mjs / recall-eval.mjs 里的 `file:///E:/2/...` 硬编码改成相对路径，
 * 否则整个仓库搬个位置，测试自己就先崩了）。
 *
 * 本模块自身零依赖，且被 test.mjs 第 16 节守护 —— 红线由测试执行，不靠人自觉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 剥掉注释，避免把「注释里举例的 import」当成真依赖（本文件的文档注释里就有例子）。
 *
 * ⚠️ 行注释的判据必须排除 `/` 而不能只排除 `:`（2026-09-19 实测踩）：
 * `file:///E:/2/x.mjs` 里第二、三个斜杠前面是 `/`，用 `[^:]\/\/` 会被当注释起点、
 * 一路删到行尾（连闭合引号一起删），于是正则跨行匹配到下一个引号，
 * 报出来的 spec 变成 `file:/\nconst r = …` 这种被污染的怪东西。
 * 排除 `:` 与 `/` 两个前导字符后 `file:///` 不再被误判。
 * 残留局限：字符串里出现「非 : / 字符 + //」（如 `'a//b'`）仍会被误删 ——
 * 方向是**漏报**而非误报，且不影响「红线红了就是真红」这个信任前提。
 */
function stripComments(src) {
  // 块注释替换成**等量换行的空白**，而不是删成空串 —— 后者会把行号整体前移，
  // 报出来的行号与编辑器里对不上（实测：真违规在 181 行，报的是 173）。
  // 红线要能被人拿着行号直接跳过去，行号失真等于判据不可用。
  const keepLines = (m) => m.replace(/[^\n]/g, ' ');
  return src.replace(/\/\*[\s\S]*?\*\//g, keepLines).replace(/(^|[^:/])\/\/[^\n]*/gm, '$1');
}

/** 四种依赖写法：from 型、副作用型、动态 import、require。 */
const PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
];

/**
 * 收集一段源码里的全部依赖说明符（带行号，按行排序、同 spec 去重）。
 * @param src - 模块源码。
 * @returns 依赖说明符数组。
 */
function scanSpecifiers(src) {
  const clean = stripComments(src);
  const seen = new Set();
  const found = [];
  for (const re of PATTERNS) {
    for (const m of clean.matchAll(re)) {
      const line = clean.slice(0, m.index).split('\n').length;
      const key = `${line}:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ spec: m[1], line });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/**
 * 判定一个说明符属于哪一类。
 * @param spec - 依赖说明符。
 * @returns builtin（Node 内置）/ relative（相对路径）/ forbidden（红线外）。
 */
function classify(spec) {
  if (spec.startsWith('node:')) return 'builtin';
  if (spec.startsWith('./') || spec.startsWith('../')) return 'relative';
  return 'forbidden';
}

/**
 * 列出 root 下的所有 .mjs（递归，跳过 node_modules）。
 * @param root - 扫描根目录。
 * @returns 绝对路径数组。
 */
export function listModules(root = HERE) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
      } else if (e.name.endsWith('.mjs')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 零依赖审计：扫全部模块，分出合规目标与违规项。
 * @param root - 扫描根目录（默认 bank/）。
 * @returns 文件数、去重后的合规说明符、违规清单。
 */
export function auditDependencies(root = HERE) {
  const files = listModules(root);
  const bySpec = new Map();
  const violations = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    for (const { spec, line } of scanSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const kind = classify(spec);
      if (kind === 'forbidden') violations.push({ file: rel, spec, line });
      else bySpec.set(spec, kind);
    }
  }
  return {
    files: files.length,
    specifiers: [...bySpec.entries()].map(([spec, kind]) => ({ spec, kind })),
    violations,
  };
}
