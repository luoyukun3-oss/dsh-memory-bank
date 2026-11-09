// ============================================================================
// Memory Bank · pre-tool 判据（2026-11-09 从 hooks/pre-tool.mjs 按域拆出）
//   为什么拆：pre-tool.mjs 实测 146 / 预算 150（97%）逼近红线，而本文件是**纯函数、零 IO**
//   （不读 stdin、不写文件、不 spawn）—— 与「hook 入口」正是两个域，拆开后可独立单测。
//   ⚠️ 入口仍是 hooks/pre-tool.mjs（DSH 按该路径挂载）⇒ 拆分不改任何挂载路径；
//      pre-tool.mjs 用 `export { risksOf }` 把本模块的导出原样转出，对外符号集合不变。
// ============================================================================

/** 安全阀：命中就放行，免得判据写错时把整轮工作锁死。 */
export function escapeHatch(cmd) {
  return /#\s*hook-allow|--hook-allow/.test(cmd);
}

/** 剥掉单/双引号字符串的**内容**（保留引号本身），用于判断「变量是不是裸传」。
 *  裸传 = 变量出现在引号外 ⇒ PowerShell 会把多行值按空白切开、只留第一段。
 *  ⚠️ 只在本文件内用（risksOf 里 6 处）⇒ 不 export（2026-11-09 `cli dead` 报的多余导出）。 */
function stripQuoted(line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      out += "'"; i += 1;
      while (i < line.length && line[i] !== "'") { out += ' '; i += 1; }
      if (i < line.length) { out += "'"; i += 1; }
    } else if (c === '"') {
      out += '"'; i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '`') { out += '  '; i += 2; } else { out += ' '; i += 1; }
      }
      if (i < line.length) { out += '"'; i += 1; }
    } else { out += c; i += 1; }
  }
  return out;
}

/** 外部程序名（这些命令的参数会被 shell/argv 拆分，是受害方）。 */
const EXTERNAL = /\b(node|node\.exe|python|python3|py|docker|git|npm|pnpm|yarn|pip|gh|curl)\b/i;

/**
 * 找出这条命令里的风险。返回 [{ what, fix }]，空数组＝放行。
 * 判据一律取「宁可漏报、不可误报」：误报会打断正常工作，漏报只是回到现状。
 */
export function risksOf(cmd) {
  const out = [];
  if (typeof cmd !== 'string' || cmd.length === 0) return out;
  const lines = cmd.split(/\r?\n/);

  // ── 风险 ①：`cli.mjs remember` 不走 --text-file（零误报，直击我实际犯的那个错）
  //    实测：`$c = Get-Content x.txt -Raw; node cli.mjs remember $c --page p.md`
  //    ⇒ 变量在换行处截断，正文只剩第一行，`--page` 整个消失 ⇒ 落回默认页 notes.md。
  //    ⚠️ 同风险②：一律在 stripQuoted 后的文本上判 —— 免得「引号内提到 --text-file」被判成"带了参数"。
  const flat = lines.map(stripQuoted).join('\n');
  if (/\bcli\.mjs\b/.test(flat) && /\bremember\b/.test(flat) && !/--text-file\b/.test(flat)) {
    out.push({
      what: 'remember 没走 --text-file（正文经 shell 传参会被换行/反引号截断，--page 也会一起消失）',
      fix: '先用 write 工具把正文落成 .txt，再跑：cli.mjs remember --text-file <路径> --page <页名>',
    });
  }

  // ── 风险 ②：`-Raw` 读进变量，再把该变量**裸传**给外部程序
  //    （变量值 hook 看不到，但「多行来源 + 裸传」这个组合本身就是判据）
  // ⚠️ 2026-10-14 修误报（hook 上线后**第一次真实拦截就是拦了我自己**，且是误报）：
  //   实例 = `$cmd = '$c = Get-Content x -Raw' + "`n" + 'node a.mjs $c'`（在拼 payload 字符串）。
  //   三处都判错了，全部同源 —— **把引号里的「数据」当成了「代码」**：
  //     ① 原 `rawVars` 用**原始行**匹配 ⇒ 把单引号里的 `Get-Content … -Raw` 当成了真读文件；
  //     ② 原 `EXTERNAL` 也测**原始行** ⇒ 把单引号里的 `node a.mjs` 当成了真调用；
  //     ③ 再把 `$cmd`（其实只是被赋值）判成"裸传"。
  //   ⇒ 三条统一改法：**一切判据都在 `stripQuoted()` 之后的文本上做**（引号内容已被抹成空格），
  //     并**跳过赋值行**（`$x = …` 是定义，不是传参）。
  const rawVars = new Set();
  for (const line of lines) {
    const m = stripQuoted(line).match(/\$(\w+)\s*=\s*.*\b(Get-Content|gc|cat|type)\b.*-Raw/i);
    if (m) rawVars.add(m[1]);
  }
  if (rawVars.size > 0) {
    for (const line of lines) {
      const bare = stripQuoted(line);            // 只看引号外的部分
      if (/^\s*\$\w+\s*=/.test(bare)) continue;  // 赋值行：定义，不是传参
      if (!EXTERNAL.test(bare)) continue;
      for (const v of rawVars) {
        if (new RegExp(`\\$${v}\\b`).test(bare)) {
          out.push({
            what: `变量 $${v} 来自 -Raw 读取（可能多行），却裸传给了外部命令 ⇒ 换行处会被截断，后续参数一起丢失`,
            fix: `改用文件传参（--text-file 之类）；确需传值就加双引号并确认它是单行`,
          });
          break;
        }
      }
    }
  }

  return out;
}
