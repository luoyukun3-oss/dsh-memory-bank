// ============================================================================
// test-rel —— `rel:` 边 与 `cue:` 值的「静默错误」守护
//   2026-10-27 从 test.mjs 按域拆出（那边超了 440 行预算 6 行，这个项目的规矩是拆不压缩）。
//
// 守的是同一类病：**格式不合规时一句报错都没有，只是悄悄指错**。
//   ① `cue:` 值含空格 → parseMeta 按空白切 ⇒ 只生效到第一个词（2026-10-13 我在真库写了 3 处才发现）
//   ② `rel:` key 含空格 → 同上，边指错或指空
//   ③ `rel:` key 命中多条 → `search.mjs` 静默取第一条，指向全看条目顺序（2026-10-27 实测 61/111 条）
//   ④ `rel:` key 命中 0 条 → 死边（无害，但计数虚高会掩盖别的问题）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

export function runRelCueTests({ ok, real }) {
  // —— ① cue 值含空格 ——
  const badCue = [];
  for (const f of fs.readdirSync(path.join(real, 'pages')).filter((x) => x.endsWith('.md'))) {
    fs.readFileSync(path.join(real, 'pages', f), 'utf8').split('\n').forEach((line) => {
      const cm = line.match(/<!--([\s\S]*?)-->/);
      if (!cm || !/\bcue:/.test(cm[1])) return;
      // ⚠️ 只取到**下一个字段**为止（`\s+key:`）：`cue:` 后面常跟着别的字段（rel/t/i…），取到注释末尾
      // 会把它们一起吞进来误报 —— 2026-10-13 给条目建 `rel:` 边时踩到（`cue:Get-Content,行数 rel:lessons.md:…`）。
      const seg = cm[1].slice(cm[1].indexOf('cue:') + 4).split(/\s+(?=[a-z_]+:)/)[0].trim();
      if (seg.split(/\s+/).length > 1) badCue.push(`${f}: ${seg.slice(0, 40)}`);
    });
  }
  ok(badCue.length === 0, '真库里 cue: 值不许含空格（要空格用 +，否则被静默切碎）', badCue.join('; '));

  // —— ②③④ rel 边的 key 守护 ——
  // key **含空白会被 parseMeta 切碎**（与上面 cue 那条**同源**，2026-10-13 一天内犯了两次）——
  // 把建边工具正式化（tools/rel-apply.mjs）时，干跑当场抓到生成的 key 是 `2026-09-18 **`Get-Co` 这种
  // （title 前缀带空格/粗体标记）⇒ 解析后 key 只剩第一段、边指错或指空，**一句报错都没有**。
  const badRelKey = [];
  const relMiss = [];
  const relAmbiguous = [];   // 2026-10-27 新增：key 命中多条 = 指向不确定
  const relDocs = (JSON.parse(fs.readFileSync(path.join(real, 'index.json'), 'utf8')).docs) || [];
  for (const d of relDocs) for (const r of (d.meta?.rel || [])) {
    if (/\s/.test(r.key || '')) { badRelKey.push(`${d.id} key含空白`); continue; }
    // ⚠️ 判据必须用 `filter` 而不是 `find`：`search.mjs` 取的是 filter 结果的**第一条**，
    //    命中多条时它不报错、只是**悄悄挑一个** ⇒ 边指向哪里全看条目顺序（2026-10-27 实测：
    //    111 条边里 61 条这样，40 条 key 只是纯日期，`events.md:2026-10-06` 能命中 31 条）。
    const hits = relDocs.filter((x) => x.page === r.page && ((x.title || '').includes(r.key || '') || (x.text || '').includes(r.key || '')));
    if (hits.length === 0) relMiss.push(`${d.id}→${r.page}:${r.key}`);
    else if (hits.length > 1) relAmbiguous.push(`${d.id}→${r.page}:${r.key}（命中 ${hits.length} 条）`);
  }
  ok(badRelKey.length === 0, '真库 rel: 边的 key 不许含空白（会被静默切碎，与 cue 同源）', badRelKey.join('; '));
  // 死边（key 定位不到目标条目）= 指向空气。历史上曾有 7 条，2026-10-27 全部清完 ⇒ **转为硬断言**。
  ok(relMiss.length === 0, '真库 rel: 边的 key 必须能定位到目标条目（死边 = 指向空气）', relMiss.join('; '));
  // key 唯一性（2026-10-27 立，同日清完 61 条后转为硬断言）：key 必须**只命中一个**目标条目 ——
  // 命中多个时 `search.mjs` 静默取第一条，边指哪全看条目顺序，而且一句报错都没有。
  ok(relAmbiguous.length === 0, '真库 rel: 边的 key 必须只命中一个条目（多个 = 指向看条目顺序）', relAmbiguous.join('; '));
}
