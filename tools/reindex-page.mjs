// 重新索引知识页 —— 手改 pages/*.md 之后必须跑，否则检索/召回看不到改动
//   （cli.mjs 的 remember 会自动 reindex，但 edit 工具手改的不会）
//
//   用法：
//     node reindex-page.mjs faults.md            # 指定页
//     node reindex-page.mjs a.md b.md            # 多页
//     node reindex-page.mjs --all                # 全部页
//     node reindex-page.mjs faults.md --slug e-2 # 指定仓库（默认 e-2）
import fs from 'node:fs';
import path from 'node:path';
import { repoDir } from '../bank/core.mjs';
import { reindexPage } from '../bank/index.mjs';

const argv = process.argv.slice(2);
const takeOpt = (name, fb) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fb;
};
const slug = takeOpt('--slug', 'e-2');
const dir = repoDir(slug);
const all = argv.includes('--all');

const skip = new Set(['--slug', slug]);
const pages = all
  ? fs.readdirSync(path.join(dir, 'pages')).filter((f) => f.endsWith('.md')).sort()
  : argv.filter((a) => !a.startsWith('--') && !skip.has(a));

if (!pages.length) {
  console.log('用法：node reindex-page.mjs <页名...> | --all  [--slug e-2]');
  process.exit(1);
}

const pagesDir = path.join(dir, 'pages');
let ok = 0;
for (const p of pages) {
  if (!fs.existsSync(path.join(pagesDir, p))) {
    console.log(`  ✗ ${p}（不存在）`);
    continue;
  }
  try {
    reindexPage(dir, p);
    console.log(`  ✓ ${p}`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${p}：${e.message}`);
  }
}
console.log(`\n重建 ${ok}/${pages.length} 页　仓库=${slug}　${dir}`);
