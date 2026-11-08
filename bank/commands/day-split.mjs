// day-split —— 目录式按天生成（2026-10-18 用户提议：「每天一个文件夹，按事件分小文件」）
// 从 commands/day.mjs 按域拆出：那边加完这个功能后 127/90 **超限**，按本仓库规矩「先拆，不压缩行宽」。
import fs from 'node:fs';
import path from 'node:path';
import { writeText } from '../core.mjs';
import { indexDocs } from '../index.mjs';
import { buildDay, stripMd } from './day.mjs';

/** 文件名净化：中文保留，去掉路径/Windows 非法字符，截 16 字。 */
const slugify = (s) => String(s)
  .replace(/[\\/:*?"<>|]/g, '')
  .replace(/\s+/g, '-')
  .replace(/^[-.]+/, '')
  .slice(0, 16) || 'item';

/**
 * 目录式生成（2026-10-18 用户提议：「甚至在每天的时间文件夹里分布成按事件分布的小文件」）。
 *   pages/days/YYYY-MM-DD/NN-<标题>.md  —— **一件事一个文件**（粒度最细，召回不被同期其他事稀释）
 *   pages/days/YYYY-MM-DD/_index.md     —— 当天概览（指向各事件文件）
 * ⚠️ 重新生成会**先清空该目录下的 .md**（手写补充请用别的扩展名或先另存）。
 */
export function writeDaySplit(dir, date, log) {
  const sections = buildDay(dir, date);
  const base = path.join(dir, 'pages', 'days', date);
  fs.mkdirSync(base, { recursive: true });
  for (const f of fs.readdirSync(base)) if (f.endsWith('.md')) fs.unlinkSync(path.join(base, f));
  const docs = [];
  const rows = [];
  let n = 0;
  for (const s of sections) {
    for (const it of s.items) {
      n += 1;
      const title = stripMd(it).slice(0, 40) || `${s.label} ${n}`;
      const file = `${String(n).padStart(2, '0')}-${slugify(title)}.md`;
      const rel = `days/${date}/${file}`;
      writeText(path.join(base, file), [
        `# ${title}`,
        '',
        `> 来源：${s.page} · ${date}｜自动抽取（\`node bank/cli.mjs day ${date} --split\`）`,
        '',
        stripMd(it),
        '',
      ].join('\n'));
      docs.push({ id: rel, page: rel, kind: 'page', title: `${date} ${title}`, text: stripMd(it) });
      rows.push(`- ${file} · ${title}（${s.label}）`);
    }
  }
  const idxRel = `days/${date}/_index.md`;
  const idxBody = [`# ${date} · ${n} 件事`, '', ...(rows.length ? rows : ['（当天无记录）']), ''].join('\n');
  writeText(path.join(base, '_index.md'), idxBody);
  docs.push({ id: idxRel, page: idxRel, kind: 'page', title: `${date} 当天索引（${n} 件）`, text: idxBody });
  indexDocs(dir, docs);
  if (log) log(`${date}/：${sections.length} 个来源页 → ${n} 个事件文件 + _index.md`);
  return { n };
}
