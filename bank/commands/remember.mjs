// `cli remember` 的实现（2026-11-02 从 cli.mjs **按域拆出**）。
//
// 为什么拆：cli.mjs 预算 510、实测 480（94%），本轮要加「事实键」的 3 个分支，
//   直接塞进去会到 98% —— 按本仓库的规矩（budgets.json `_principle`：超限先按域拆、
//   **不准靠压缩行宽硬塞**），先把整个 remember 域搬出来，再在宽裕的地方加功能。
//   先例：2026-10-13 拆 mood（同样理由）、2026-10-26 拆 ev。
//
// 约定：**不 import cli.mjs**（循环依赖）；上下文由 cli 传进来（opt / log / dir / positional）。
import path from 'node:path';
import { clip, readJson, readText, writeText, day } from '../core.mjs';
import { reindexPage } from '../index.mjs';
import { suggestCues } from '../cue-suggest.mjs';
import { stripOwnDate } from '../text-guards.mjs';
import { FACT_KEY_RE, markSuperseded } from '../factkey.mjs';

/**
 * `cli remember "<正文>" [--page x.md] [--text-file f] [--key 对象.方面] [--dry]`
 *
 * `--key`（2026-11-02 新增）：给这条事实打上事实键。**同一个键 = 同一件事** ⇒
 *   写入后自动把该页里**同键的旧条**标上 `supersededBy`（`search.mjs` 里 ×0.25 降权、
 *   `assoc`/`cue` 直接跳过）。⚠️ 键里**不许写值**：写 `她.身高`，不写 `她.身高170`，
 *   否则值一变化键就跟着变，新旧两条永远碰不上 —— 机制当场失效。
 * `--dry`：只预览会被取代哪几条，不写盘。
 */
export function runRemember({ opt, log, dir, positional }) {
  // —— 2026-10-10 新增「从文件读正文」通道 ——
  // 起因（实测）：pwsh 里反引号是转义符。正文若写成「反引号 + node ... --dry」这种形式，
  // shell 会在那一处折行 ⇒ node 收到的正文**在反引号处被截断**、后面的 --page 也跟着错位
  // （实测：`node 打 argv` 收到 "A `node def" 只得到 ["A"]）。
  // ⇒ 长正文、或含 反引号 / 美元符 / 圆括号 / 换行 的正文，一律改用文件传入。
  const tf = opt('text-file', null);
  let raw = '';
  if (tf && tf !== true) {
    const p = path.resolve(String(tf));
    raw = (readText(p) || '').trim();
    if (!raw) { log(`--text-file 读不到内容或文件为空：${p}`); return; }
  } else {
    raw = positional.join(' ').trim();
  }
  if (!raw) { log('用法：remember "要记住的内容" [--page notes.md] [--key 对象.方面] ｜ 或 remember --text-file body.txt'); return; }

  // —— 防呆（2026-09-29）：正文开头若自己写了一遍**今天**的日期，会与下面的 `- ${day()} ` 叠加成
  //    「2026-09-28 2026-09-28 …」。此错在 09-23 / 09-24 / 09-28 复发三次、全库实测共 7 处（5 个页）
  //    ⇒ 靠记性没用，剥掉它，只保留一份前缀。
  //    ⚠️ 只剥「今天」：写昨天/历史某天是有意为之。剥完为空则回退原文，绝不静默丢内容。
  const text = stripOwnDate(raw, day()) || raw;

  // —— 事实键校验（2026-11-02）：形状不对就**当场拒绝**，别写成一条永远匹配不上的哑弹 ——
  const key = typeof opt('key') === 'string' ? String(opt('key')).trim() : null;
  if (key !== null && !FACT_KEY_RE.test(key)) {
    log(`✗ --key 形状不合法：${JSON.stringify(key)}（要求「对象.方面」，如 她.身高；不含空白、恰好一个点）`);
    return;
  }

  const page = String(opt('page', 'notes.md'));
  const f = path.join(dir, 'pages', page);
  const head = readText(f) || `# ${page.replace('.md', '')}\n`;
  // 注释挂在条目首行末尾（与页面里其他 meta 的写法一致，parseMeta 按 \s+ 切注释里的 token）
  const metaComment = key ? ` <!-- key:${key} -->` : '';
  const next = `${head}\n- ${day()} ${text}${metaComment}\n`;

  if (opt('dry')) {
    log(`【dry-run】将写入 pages/${page}${key ? `，key=${key}` : ''}：${clip(text, 120)}`);
    if (key) reportSuperseded(log, markSuperseded(next, key));
    return;
  }

  writeText(f, next);
  log(`已写入 pages/${page}：${clip(text, 120)}${text !== raw ? '（已剥离开头的重复日期）' : ''}${key ? `（key=${key}）` : ''}`);

  // —— 事实键：标掉同键旧条（**只改 meta，不删内容** —— 永不物理删除）——
  if (key) {
    const r = markSuperseded(readText(f) || next, key);
    if (r.superseded.length) {
      writeText(f, r.text);
      log(`⤷ 事实键 ${key}：${r.superseded.length} 条旧条目已标 supersededBy（内容保留，检索降权 ×0.25）`);
      for (const s of r.superseded) log(`   - ${clip(s.split('\n')[0].replace(/\s+/g, ' '), 100)}`);
    }
  }

  reindexPage(dir, page);

  // 2026-10-23：新条目默认**没有联想词** ⇒ 会长成「哑弹」（cue 是词表驱动，只认 `<!-- cue:... -->`，
  // 2026-10-15 那条教训就是这么来的）。这里只**建议、不写入**：cue 档绕过召回分数门，
  // 自动写错词的代价是每轮注入脏内容 ⇒ 由调用方过一眼再补。`--no-suggest` 可关。
  if (!opt('no-suggest')) {
    const sug = suggestCues(text, readJson(path.join(dir, 'index.json'), { docs: [] }).docs || [], { limit: 3 });
    if (sug.length) log(`💡 建议补联想词：${sug.join(' / ')}　→ 条目末尾加 <!-- cue:${sug.join(',')} -->`);
  }
}

/** 干跑时把「会被取代哪几条」打出来（与真跑的措辞区分开，避免误以为已落盘） */
function reportSuperseded(log, r) {
  if (!r.superseded.length) { log('⤷ 事实键：没有旧条目需要标 supersededBy'); return; }
  log(`⤷【dry-run】将标 supersededBy ${r.superseded.length} 条：`);
  for (const s of r.superseded) log(`   - ${clip(s.split('\n')[0].replace(/\s+/g, ' '), 100)}`);
}
