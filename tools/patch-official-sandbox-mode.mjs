#!/usr/bin/env node
// 官方桌面版补丁：把「无会话调用」的部署默认沙箱改成 danger-full-access
// ============================================================
// 为什么需要它（2026-09-30 源码级定论，行号可复核）：
//   官方 DeepSeek Harness 0.2.0-rc.2 里，**记忆银行的 hook 一条都跑不起来** ——
//   会话日志里 `hook/result` 的 exitCode 恒为 3221225794（= 0xC0000142,
//   STATUS_DLL_INIT_FAILED），开场注入因此为空；而同一个 hooks.json 在旧壳
//   （DSH Desktop 0.9.0）同一刻 15 次全成功 ⇒ 纯官方版机制差异、与会话权限无关。
//
//   因果链（每一跳都是从 app.asar 里读到的，不是推断）：
//     dsh-hook-protocol/lib/index.js:191-198  请求只有 command/timeout/stdin/workdir/env
//                                             —— **没有 session**
//       → dsh-pwsh-sandbox/lib/index.js:148   request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()
//       → dsh-sandbox-policy/lib/index.js:144 session 为空 ⇒ 取 defaultMode
//       → dsh-base/cordis.patch.yml:232       该默认值 = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
//       → dsh-subprocess-local/lib/index.js:600 子进程以 windowsHide: true 启动
//       → dsh-sandbox-windows-acl/README.zh.md:129
//           「以 CREATE_NO_WINDOW 创建的子进程在 DLL 初始化期以 0xC0000142 死亡」
//   ⇒ 受限令牌 + 隐藏控制台 = 进程还没初始化完 DLL 就死，hook 只留一个 exitCode。
//
//   ⚠️ 因此改 `permission.defaultPreset`（会话权限）**没用** ——
//      它只作用于带 session 的调用（工具调用），hook 走的是 agentless 分支。
//
// 本脚本做的事（最小改动、只加/换一个 patch 条目）：
//   在 <harness home>\profiles\desktop\cordis.patch.yml 末尾插入（或就地替换）
//       - id: sandbox-policy
//         name: "@deepseek-ai/dsh-sandbox-policy"
//         config:
//           mode: danger-full-access
//           workspaceRoot: !!js process.cwd()
//   config 必须写全表（patch 对 config 是整体替换，缺键会被打成 undefined）。
//   `!!js` 在本层是允许的（文件头注释明写）。
//
// 生效与验收：
//   ⚠️ **必须重启官方版**（patch 层在应用启动时读取），然后**开一个新会话**。
//   验收判据：① 新会话 `hook/result` 的 exitCode = 0（原先全是 3221225794）
//             ② 开场出现约 7000 字注入（【全局偏好】…）
//   回滚：`node patch-official-sandbox-mode.mjs --restore`，再重启官方版。
//
// 用法：
//   node patch-official-sandbox-mode.mjs            # 预演（默认，不写）
//   node patch-official-sandbox-mode.mjs --apply    # 写入（自动备份到 tools/_bak/）
//   node patch-official-sandbox-mode.mjs --restore  # 从最近一次备份还原
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAK_DIR = path.join(HERE, '_bak');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const RESTORE = args.has('--restore');

const HARNESS_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const TARGET =
  process.env.DSH_DESKTOP_PROFILE_PATCH ||
  path.join(HARNESS_HOME, 'profiles', 'desktop', 'cordis.patch.yml');

const BLOCK = [
  '# [补丁] hook 等「无会话调用」用的部署默认沙箱：workspace-write 会让 ACL 受限令牌',
  '# 下的子进程以 0xC0000142 死掉（windowsHide ⇒ CREATE_NO_WINDOW），hook 全体静默失败。',
  '# 详见 _dsh_memory/tools/patch-official-sandbox-mode.mjs 头注释与 pages/faults.md。',
  '- id: sandbox-policy',
  '  name: "@deepseek-ai/dsh-sandbox-policy"',
  '  config:',
  '    mode: danger-full-access',
  '    workspaceRoot: !!js process.cwd()',
];

const isEntryStart = (l) => /^-\s/.test(l);
const isOurs = (l) => /^-\s*id:\s*sandbox-policy\s*$/.test(l);

function blockRange(lines) {
  const i = lines.findIndex(isOurs);
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !isEntryStart(lines[j])) j++;
  return [i, j];
}

function bakList() {
  try {
    return fs
      .readdirSync(BAK_DIR)
      .filter((f) => f.startsWith('cordis.patch.yml.bak-'))
      .sort();
  } catch {
    return [];
  }
}

function restore() {
  const list = bakList();
  if (!list.length) {
    console.error(`没有备份可还原（${BAK_DIR}）`);
    process.exit(1);
  }
  const newest = path.join(BAK_DIR, list[list.length - 1]);
  fs.copyFileSync(newest, TARGET);
  console.log(`已还原：${newest} → ${TARGET}`);
  console.log('⚠️ 重启官方版后生效。');
}

function main() {
  console.log(`目标文件：${TARGET}`);
  if (!fs.existsSync(TARGET)) {
    console.error('目标文件不存在 —— 确认官方桌面版装过、且 profile 名是 desktop。');
    process.exit(1);
  }
  const raw = fs.readFileSync(TARGET, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const trailingBlank = lines[lines.length - 1] === '';
  const body = trailingBlank ? lines.slice(0, -1) : lines.slice();
  const range = blockRange(body);

  console.log(`现状：${body.length} 行${range ? `，已有 sandbox-policy 条目（第 ${range[0] + 1}-${range[1]} 行）` : '，还没有 sandbox-policy 条目'}`);

  let next;
  if (range) {
    const cur = body.slice(range[0], range[1]);
    const already = cur.some((l) => /^\s*mode:\s*danger-full-access\s*$/.test(l));
    if (already) {
      console.log('✅ 已是目标状态（mode: danger-full-access），无需改动。');
      return;
    }
    console.log('将要替换的现有条目：');
    for (const l of cur) console.log('  - ' + l);
    next = [...body.slice(0, range[0]), ...BLOCK, ...body.slice(range[1])];
  } else {
    next = [...body, ...BLOCK];
  }

  console.log('\n将要写入的内容：');
  for (const l of BLOCK) console.log('  + ' + l);

  if (!APPLY) {
    console.log('\n（预演模式，未写入。确认无误后加 --apply）');
    return;
  }

  fs.mkdirSync(BAK_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bak = path.join(BAK_DIR, `cordis.patch.yml.bak-${stamp}`);
  fs.copyFileSync(TARGET, bak);
  fs.writeFileSync(TARGET, next.join(eol) + eol, 'utf8');

  // 读回验证：块在、且其余内容未被动过
  const after = fs.readFileSync(TARGET, 'utf8');
  const r2 = blockRange(after.split(/\r?\n/));
  const ok = r2 !== null && /mode:\s*danger-full-access/.test(after.split(/\r?\n/).slice(r2[0], r2[1]).join('\n'));
  const sizeDelta = after.length - raw.length;
  console.log(`\n已写入。备份：${bak}`);
  console.log(`读回验证：${ok ? '✅ 条目在位且 mode 正确' : '❌ 校验失败，请 --restore'}；文件 ${raw.length} → ${after.length} 字节（Δ${sizeDelta >= 0 ? '+' : ''}${sizeDelta}）`);
  console.log('⚠️ 下一步：**重启官方桌面版**，再开一个新会话；验收判据见本脚本头注释。');
}

RESTORE ? restore() : main();
