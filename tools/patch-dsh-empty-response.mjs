#!/usr/bin/env node
// 给 DSH 内核包打补丁：让「只有 reasoning、既无正文也无工具调用」的空回复被判为
// EMPTY_RESPONSE **错误**（该错误码已在默认重试白名单内 ⇒ 自动重试救回），
// 而不是当作 stop 静默成功。
//
// 根因与证据：`_dsh_memory/issues/2026-09-18-dsh-reasoning-only-empty-message.md`
// 补丁清单（**单一数据源**）：`_dsh_memory/patches.json` —— 与 `bank/patch-status.mjs`
// 共用同一份锚点，避免两处各写一份而漂移。
//
// 用法：
//   node patch-dsh-empty-response.mjs                 预演（默认，**不写文件**）
//   node patch-dsh-empty-response.mjs --apply          应用（自动备份 + 语法检查）
//   node patch-dsh-empty-response.mjs --restore        还原（每条补丁取各自最近一次备份）
//   … 以上都可加 `--only <id>` 只处理清单里的某一条
//
// ⚠️ 目标在【DSH 应用安装目录】里，升级/重装即被覆盖 —— 升级后重跑本脚本即可。
// ⚠️ 改完**必须重启 DSH** 才生效（内核包不参与插件热挂载）。
//    复查用 `node E:\2\_dsh_memory\bank\cli.mjs sweep` 的 ⑥ 段（报「在位 + 生效」）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MANIFEST = path.join(path.dirname(HERE), 'patches.json');   // tools/ → _dsh_memory/

const CANDIDATE_APP_ROOTS = [
  'E:/3/DSH Desktop/resources/app',
  'C:/Program Files/DSH Desktop/resources/app',
];

const BAK_DIR = path.join(HERE, '_bak');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESTORE = args.includes('--restore');
const onlyAt = args.indexOf('--only');
const ONLY = onlyAt === -1 ? null : args[onlyAt + 1];

const countOf = (hay, needle) => hay.split(needle).length - 1;
const stamp = () => {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
};

if (!fs.existsSync(MANIFEST)) { console.error('✗ 找不到补丁清单：' + MANIFEST); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const patches = (manifest.patches || []).filter((p) => ONLY === null || p.id === ONLY);
if (patches.length === 0) {
  console.error('✗ 清单里没有可处理的补丁' + (ONLY === null ? '（清单为空）' : '：' + ONLY));
  process.exit(2);
}

/** 定位某条补丁的目标文件（多候选安装根，取第一个存在的）。 */
function findTarget(rel) {
  for (const root of CANDIDATE_APP_ROOTS) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

if (RESTORE) {
  let done = 0;
  for (const p of patches) {
    const target = findTarget(p.rel);
    if (target === null) { console.error(`✗ [${p.id}] 找不到目标文件`); continue; }
    const baks = fs.existsSync(BAK_DIR)
      ? fs.readdirSync(BAK_DIR).filter((f) => f.startsWith(`${p.pkg}.index.js.bak-`)).sort()
      : [];
    if (baks.length === 0) { console.error(`✗ [${p.id}] 没有备份可还原`); continue; }
    fs.copyFileSync(path.join(BAK_DIR, baks[baks.length - 1]), target);
    console.log(`✓ [${p.id}] 已还原自 ${baks[baks.length - 1]}`);
    done++;
  }
  console.log(done ? `\n✓ 还原 ${done} 条。⚠️ 同样需要重启 DSH 才生效。` : '\n✗ 没有任何补丁被还原。');
  process.exit(done ? 0 : 2);
}

let applied = 0;
let already = 0;
let refused = 0;

for (const p of patches) {
  console.log(`\n=== [${p.id}] ${p.title} ===`);
  const target = findTarget(p.rel);
  if (target === null) {
    console.error('✗ 找不到目标文件，尝试过：');
    for (const r of CANDIDATE_APP_ROOTS) console.error('   ' + path.join(r, p.rel));
    refused++;
    continue;
  }
  console.log('目标：' + target);

  const buf = fs.readFileSync(target);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const src = buf.toString('utf8');
  const nOld = countOf(src, p.oldLine);
  const nNew = countOf(src, p.newLine);
  console.log(`锚点（原判据）${nOld} 次｜补丁版判据 ${nNew} 次｜BOM: ${hasBom}｜换行: ${src.includes('\r\n') ? 'CRLF' : 'LF'}`);

  if (nNew === 1 && nOld === 0) { console.log('✓ 已经处于补丁状态，无需改动（幂等）'); already++; continue; }
  if (nOld !== 1 || nNew !== 0) {
    console.error('✗ 锚点不唯一或不匹配 —— **拒绝写入**。多半是 DSH 升级后源码变了，请先复核 issue 里的根因段落。');
    refused++;
    continue;
  }

  console.log('将做这一处替换：');
  console.log('  - ' + p.oldLine);
  console.log('  + ' + p.newLine);

  if (!APPLY) { console.log('（预演：本条目未写文件）'); continue; }

  fs.mkdirSync(BAK_DIR, { recursive: true });
  const bak = path.join(BAK_DIR, `${p.pkg}.index.js.bak-${stamp()}`);
  fs.writeFileSync(bak, buf);
  console.log('✓ 已备份 → ' + bak);

  // 临时文件必须留 `.mjs` 扩展名：原包是 ESM，而 `node --check` 不认识自定义扩展名
  // （实测 `.patchtmp` 会抛 ERR_UNKNOWN_FILE_EXTENSION）。同目录才能原子 rename。
  const tmp = target + '.patchtmp.mjs';
  fs.writeFileSync(tmp, src.replace(p.oldLine, p.newLine), 'utf8');
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    console.error('✗ 语法检查未通过，已放弃写入：' + String(err.stderr || err.message).slice(0, 400));
    refused++;
    continue;
  }
  fs.renameSync(tmp, target);
  const after = fs.readFileSync(target, 'utf8');
  console.log(`✓ 语法检查通过，已写入（复核：补丁版 ${countOf(after, p.newLine)} 次 / 原判据 ${countOf(after, p.oldLine)} 次）`);
  applied++;
}

console.log(`\n汇总：已应用 ${applied}｜本就处于补丁态 ${already}｜拒绝/失败 ${refused}`);
if (!APPLY) console.log('（预演结束，未写文件。加 --apply 才真正写入）');
if (APPLY && applied > 0) {
  console.log('\n⚠️ 改的是内核包 ⇒ **必须重启 DSH** 才生效。');
  console.log('   复查：node E:\\2\\_dsh_memory\\bank\\cli.mjs sweep  →  ⑥ 段');
  console.log('   回滚：node ' + path.basename(process.argv[1]) + ' --restore');
}
process.exit(refused ? 2 : 0);
