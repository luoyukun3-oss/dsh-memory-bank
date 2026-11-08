#!/usr/bin/env node
/**
 * migrate-install.mjs —— 「迁移即用」一键安装（记忆系统 + profile 配置）
 *
 * 用法（在新电脑上，DSH 装好之后）：
 *   node <工作区>/_dsh_memory/tools/migrate-install.mjs            # 干跑：只报告要改什么
 *   node <工作区>/_dsh_memory/tools/migrate-install.mjs --apply    # 真改（会先备份）
 *
 * 它做四件事：
 *   1. 由自己的位置反推工作区路径（_dsh_memory 的父目录）
 *   2. 找到 DSH 的 profile 目录（%APPDATA%\dsh-desktop\harness\profiles\web）
 *   3. 修正 cordis.patch.yml 里写死的绝对路径（sandbox-policy.workspaceRoot / dsh-todo-panel.file）
 *   4. 体检：检查关键文件在不在、bundles 清单对不对、bank 能不能跑
 *
 * 设计原则：**默认干跑**、**改前备份**、**每步都打印命中数**，MISS 显式报出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url)); // <ws>/_dsh_memory/tools
const MEM = path.resolve(HERE, '..');                      // <ws>/_dsh_memory
const WS = path.resolve(MEM, '..');                        // <ws>

const log = (s = '') => console.log(s);
const ok = (s) => log('  ✓ ' + s);
const bad = (s) => log('  ✗ ' + s);
const warn = (s) => log('  ⚠ ' + s);
const info = (s) => log('  · ' + s);

log('════════════════════════════════════════════════');
log(' 记忆系统迁移安装' + (APPLY ? '（APPLY 模式：会真的改文件）' : '（干跑模式：只报告）'));
log('════════════════════════════════════════════════');
log();
log('【1】路径探测');
ok('记忆库：' + MEM);
ok('工作区：' + WS);
const wsSlash = WS.replace(/\\/g, '/');
info('工作区（正斜杠，写进配置用）：' + wsSlash);
// slug 规则**照抄** bank/core.mjs:219 的 slugOf()（不能自己发明 —— 首次实现时按"目录名"算，
// 把 E:\2 算成了 "2"，与真实的 e-2 不符）。规则：整条路径里的 : \ / 空格 都换成 -，去首尾 -，转小写。
const slugOf = (cwd) => {
  const p = path.resolve(cwd).replace(/[\\/]+$/, '');
  return p.replace(/[:\\/\s]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || '_root';
};
const slug = slugOf(WS);
info('仓库 slug：' + slug + '（记忆银行按它隔离；与 core.mjs 的 slugOf 同算法）');

const repoDir = path.join(MEM, 'repos', slug);
log();
log('【2】记忆库体检');
const need = [
  ['bank/cli.mjs', '记忆银行 CLI'],
  ['bank/bank.mjs', '银行核心'],
  ['tools/reindex-page.mjs', '重索引工具'],
  ['MEMORY.md', '长期记忆主干'],
];
for (const [rel, label] of need) {
  const p = path.join(MEM, rel);
  if (fs.existsSync(p)) ok(label + '：' + rel); else bad(label + ' 缺失：' + rel);
}
if (fs.existsSync(repoDir)) {
  const pages = fs.existsSync(path.join(repoDir, 'pages'))
    ? fs.readdirSync(path.join(repoDir, 'pages')).filter((f) => f.endsWith('.md') && !f.includes('.bak')).length
    : 0;
  ok('本仓库知识页目录存在：repos/' + slug + '（' + pages + ' 个正式页）');
} else {
  bad('知识页目录不存在：repos/' + slug + '  ← 若工作区被改名了，把 repos/ 里那个目录改名为 ' + slug);
}

log();
log('【3】profile 目录');
const prof = path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'profiles', 'web');
if (!fs.existsSync(prof)) {
  bad('找不到 profile：' + prof);
  log('     ⇒ DSH 装好并至少启动过一次之后再来跑这个脚本。');
  process.exit(1);
}
ok('profile：' + prof);
const patchPath = path.join(prof, 'cordis.patch.yml');
if (!fs.existsSync(patchPath)) bad('缺 cordis.patch.yml（从迁移包的 _migrate_2_profile_config 里解压它）');
else ok('cordis.patch.yml 存在');

log();
log('【4】修正 cordis.patch.yml 里的绝对路径');
if (fs.existsSync(patchPath)) {
  const text = fs.readFileSync(patchPath, 'utf8');
  // 找出所有含盘符的路径，判断是不是指向旧工作区
  const pathRe = /([A-Za-z]:[\\/][^\s'"\n]*)/g;
  const found = [...new Set((text.match(pathRe) || []))];
  const stale = found.filter((p) => {
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const cur = wsSlash.toLowerCase();
    // 含 _dsh_memory 或看起来像工作区根的路径，且不等于当前工作区
    return /_dsh_memory/i.test(norm) || /^[a-z]:\/[^/]+$/i.test(norm);
  });
  if (found.length === 0) info('配置里没有绝对路径（可能已经是相对/通配写法）');
  else {
    info('配置里出现的绝对路径：');
    found.forEach((p) => info('  ' + p + (stale.includes(p) && !p.replace(/\\/g,'/').toLowerCase().startsWith(wsSlash.toLowerCase()) ? '   ← 指向别处' : '')));
  }
  // 需要替换的：旧的 <盘>:/2 形式 → 当前工作区
  const targets = [...new Set([...text.matchAll(/([A-Za-z]:[\\/](?:[^\\/\s'"\n]+)[\\/]_dsh_memory)/g)].map((m) => m[1]))];
  let changed = text;
  let hits = 0;
  for (const t of targets) {
    const tNorm = t.replace(/\\/g, '/').toLowerCase();
    if (tNorm === (wsSlash + '/_dsh_memory').toLowerCase()) continue;
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\/g, '[\\\\/]'), 'g');
    const n = (changed.match(re) || []).length;
    if (n > 0) {
      changed = changed.replace(re, wsSlash + '/_dsh_memory');
      hits += n;
      info('替换 ' + t + ' → ' + wsSlash + '/_dsh_memory  （' + n + ' 处）');
    }
  }
  if (hits === 0) ok('无需替换（路径已指向当前工作区，或者用的是相对写法）');
  else if (!APPLY) warn('干跑：将替换 ' + hits + ' 处 —— 加 --apply 才会真改');
  else {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const bak = patchPath + '.bak-' + stamp;
    fs.copyFileSync(patchPath, bak);
    fs.writeFileSync(patchPath, changed, 'utf8');
    ok('已替换 ' + hits + ' 处，原文件备份为 ' + path.basename(bak));
  }
}

log();
log('【5】插件 bundles 清单');
const pkgPath = path.join(prof, 'package.json');
if (fs.existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || [];
    const must = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-memory-bank-hooks', 'dsh-todo-panel'];
    info('bundles 共 ' + bundles.length + ' 项');
    for (const m of must) {
      if (bundles.includes(m)) ok('含 ' + m);
      else warn('缺 ' + m + '  ← 把它加进 dsh.profile.bundles，或重新解压 _migrate_2_profile_config 覆盖本文件');
    }
    const deps = Object.keys(pkg.dependencies || {});
    const links = deps.filter((d) => String(pkg.dependencies[d]).startsWith('link:'));
    if (links.length) {
      info('依赖里有 ' + links.length + ' 个 link: 项（指向 .local-bundles）：');
      links.forEach((d) => info('  ' + d + ' → ' + pkg.dependencies[d]));
      warn('link: 依赖要求对应目录存在；三个本地插件在迁移包的 .local-bundles 里。');
    }
  } catch (e) {
    bad('package.json 解析失败：' + e.message);
  }
} else bad('缺 profile/package.json');

log();
log('【6】跑一次 bank，验证能工作');
const cli = path.join(MEM, 'bank', 'cli.mjs');
if (fs.existsSync(cli)) {
  const r = spawnSync(process.execPath, [cli, 'preview'], { encoding: 'utf8', cwd: WS, timeout: 120000 });
  if (r.status === 0 && r.stdout) {
    const chinese = (r.stdout.match(/[\u4e00-\u9fa5]/g) || []).length;
    ok('cli preview 正常，输出 ' + r.stdout.length + ' 字符（其中中文 ' + chinese + ' 字）');
    const line = r.stdout.split('\n').find((l) => /待办|注入|预算|字数/.test(l));
    if (line) info('摘要行：' + line.trim().slice(0, 100));
  } else {
    bad('cli preview 失败（exit ' + r.status + '）');
    if (r.stderr) info(String(r.stderr).split('\n').slice(0, 5).join('\n    '));
  }
} else bad('找不到 bank/cli.mjs');

log();
log('════════════════════════════════════════════════');
log(' 剩下要手动做的');
log('════════════════════════════════════════════════');
log('  1. 把三个本地插件放进 profile：');
log('     .local-bundles\\  →  %APPDATA%\\dsh-desktop\\harness\\profiles\\web\\.local-bundles\\');
log('  2. npm 插件按清单重装（见《迁移到新电脑.md》B 节，带版本号）');
log('  3. .npmrc 里的 npm token 若已过期，去 npmjs.com 重新生成（勾「绕过 2FA」）');
log('  4. 重启 DSH，然后看 harness.log 有没有 patch: entry "..." not found');
if (!APPLY) {
  log();
  warn('本次是干跑，什么都没改。确认无误后加 --apply 再跑一次。');
}
log();
