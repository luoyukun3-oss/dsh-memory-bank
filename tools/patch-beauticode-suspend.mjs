#!/usr/bin/env node
// beautiCode 补丁：背景视频「隐藏即停」
// ============================================================
// 为什么需要这个补丁（2026-09-18 调研结论，实测证据）：
//   ① beautiCode 的 client.js 全库 grep：`visibilitychange` **0 匹配**、`playbackRate` **0 匹配**
//      ⇒ 它没有省电逻辑 —— 页面切走/最小化后，背景视频仍在解码。
//   ② 浏览器**没有**帮我们兜底：Chrome 的后台视频优化官方公告标题即
//      "Background video track optimizations **(MSE only)**" —— 只覆盖 Media Source Extensions，
//      而 beautiCode 走的是「回环 HTTP + Range 的普通 <video src>」，不在该范围内。
//   ③ **不能从外面打补丁**（重要）：client.js 用 `video.paused` 判定「这个视频槽位是否还有效」，
//      外部 pause 会被误判成「视频坏了」→ 可能重建元素，反而更耗。
//      ⇒ 只能改包内部，并让那个判据知道「这是主动暂停」。
//
// 本脚本做两处**最小**改动：
//   [1] 在 `warmUpMediaStack();` 之后插入可见性守卫（visibilitychange → pause/play）
//   [2] 把 `video.paused ||` 判据放宽为「暂停但被打过 bcSuspended 标记 → 仍视为有效」
//
// ⚠️ 为什么必须脚本化：`beauticode-dsh` 是**第三方包**，node_modules 里是 Junction 指向
//    DSH 的 `.generations\live\<包名>+<版本>+<hash>\` 代际目录 ——
//    **插件升级或 DSH 换代都会让手改消失**（2026-09-18 实测：1.0.24 → 1.0.25 就是这么过的）。
//    本脚本**基于文本锚点**（不是行号）、**幂等**、**锚点不命中就拒绝写入**，升级后重跑即可。
//
// 用法：
//   node patch-beauticode-suspend.mjs            # 预演（默认；只报告锚点命中情况，不写）
//   node patch-beauticode-suspend.mjs --apply     # 真正写入（自动备份到 _bak/）
//   node patch-beauticode-suspend.mjs --restore   # 从最近一次备份还原
//
// 打完之后怎么验证：
//   把背景设成**视频** → 切到别的标签页几十秒 → 切回来。
//   预期：切走期间视频定格（不再解码），切回来从原处继续播、背景不闪、不重建。
//   若出现「背景变静态图 / 闪一下 / 不恢复」→ 立即 --restore 还原。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BAK_DIR = path.join(HERE, '_bak');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const RESTORE = args.has('--restore');

const PROFILE =
  process.env.BEAUTICODE_PROFILE ||
  path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'profiles', 'web');
const CLIENT = path.join(PROFILE, 'node_modules', 'beauticode-dsh', 'client.js');
const MARK = 'beauticode-suspend-guard';

// —— 插入的守卫代码（缩进与所在作用域对齐：2 空格）——
const GUARD = `  // —— [补丁 ${MARK}] 背景视频「隐藏即停」——
  //    页面不可见时暂停背景视频；恢复可见时接着播。
  //    bcSuspended 标记是必需的：下面的「槽位可否复用」判据把 paused 当成「视频坏了」，
  //    不加标记会被误判成失效并重建元素。
  try {
    if (!document.documentElement.dataset.bcSuspendGuard) {
      document.documentElement.dataset.bcSuspendGuard = "1";
      document.addEventListener("visibilitychange", () => {
        const slot = document.querySelector("#beauticode-bg-stage .beauticode-media-slot");
        const video = slot?.querySelector?.("video");
        if (!(video instanceof HTMLVideoElement)) return;
        if (document.hidden) {
          if (!video.paused) {
            video.dataset.bcSuspended = "1";
            try { video.pause(); } catch {}
          }
        } else if (video.dataset.bcSuspended === "1") {
          const p = video.play?.();
          const clear = () => { try { delete video.dataset.bcSuspended; } catch {} };
          if (p && typeof p.then === "function") p.then(clear, clear);
          else clear();
        }
      });
    }
  } catch {}
`;

// ⚠️ 锚点一律用**单行**：跨行锚点会被换行风格坑到 ——
//    2026-09-18 首版写成 `...;\n\n  function ...`，结果 **0 命中**（文件是 CRLF，`\n` 匹配不上）。
//    单行锚点 + 按文件实际风格拼插入内容的换行，才稳。
function buildPatches(NL) {
  const guard = GUARD.split('\n').join(NL);
  return [
    {
      name: '插入可见性守卫',
      find: '  warmUpMediaStack();',
      replace: '  warmUpMediaStack();' + NL + NL + guard + NL,
    },
    {
      name: '放宽「槽位可复用」判据',
      find: '      video.paused ||',
      replace:
        '      (video.paused && video.dataset.bcSuspended !== "1") ||   // [补丁] 主动暂停（隐藏即停）不算失效',
    },
  ];
}

function countOccurrences(hay, needle) {
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

if (!fs.existsSync(CLIENT)) {
  console.error(`✗ 找不到 client.js：\n  ${CLIENT}`);
  process.exit(2);
}

// —— 还原 ——
if (RESTORE) {
  if (!fs.existsSync(BAK_DIR)) {
    console.error(`✗ 没有备份目录：${BAK_DIR}`);
    process.exit(1);
  }
  const baks = fs
    .readdirSync(BAK_DIR)
    .filter((f) => f.startsWith('beauticode-client.js.bak-'))
    .sort();
  if (!baks.length) {
    console.error('✗ 没有可用备份');
    process.exit(1);
  }
  const latest = path.join(BAK_DIR, baks[baks.length - 1]);
  fs.copyFileSync(latest, CLIENT);
  console.log(`✓ 已从备份还原：${baks[baks.length - 1]}`);
  process.exit(0);
}

const src = fs.readFileSync(CLIENT, 'utf8');

if (src.includes(MARK)) {
  console.log('• 当前已是「已打补丁」状态，无需重复。');
  console.log('  （要撤销用 --restore）');
  process.exit(0);
}

const NL = src.includes('\r\n') ? '\r\n' : '\n';
const PATCHES = buildPatches(NL);

let out = src;
let allOk = true;

console.log(`目标文件：${CLIENT}`);
console.log(`当前大小：${src.length} 字符\n`);
console.log('锚点检查：');
for (const p of PATCHES) {
  const n = countOccurrences(out, p.find);
  const flag = n === 1 ? '✓' : '✗';
  console.log(`  ${flag} [${p.name}] 命中 ${n} 处（期望 1）`);
  if (n !== 1) {
    allOk = false;
    continue;
  }
  out = out.replace(p.find, p.replace);
}

if (!allOk) {
  console.error('\n✗ 有锚点未命中 —— 上游代码结构可能已变，**未做任何写入**。');
  console.error('  请人工核对 client.js 后更新本脚本的 find/replace 锚点。');
  process.exit(1);
}

if (!APPLY) {
  console.log(`\n• 预演通过：两处锚点各命中 1 处，替换后 ${out.length} 字符（${out.length - src.length >= 0 ? '+' : ''}${out.length - src.length}）。`);
  console.log('  未写入任何文件。要应用请加 --apply。');
  process.exit(0);
}

fs.mkdirSync(BAK_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bakName = `beauticode-client.js.bak-${stamp}`;
fs.writeFileSync(path.join(BAK_DIR, bakName), src, 'utf8');
fs.writeFileSync(CLIENT, out, 'utf8');

console.log(`\n✓ 已备份：_bak/${bakName}`);
console.log(`✓ 已写入：${CLIENT}`);
console.log('\n验证方法：把背景设成视频 → 切走标签页几十秒 → 切回来。');
console.log('预期：切走期间定格，切回继续播且不闪、不重建。异常则 --restore。');
