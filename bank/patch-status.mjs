// 外挂补丁自检（2026-09-18 新增，独立模块 —— degenerate-audit.mjs 已 99% 逼近预算）
// ============================================================
// 为什么需要它：给 DSH 打的补丁**写在应用安装目录里**，它有两处天然脆弱 ——
//   ① **DSH 升级/重装即被覆盖**（补丁脚本头部自己写着「升级后重跑即可」——
//      靠人记得，就是会忘；实测 beauticode 包当天就从 1.0.24 升到 1.0.25）；
//   ② **改完不重启不生效**（内核包不参与插件热挂载）。
// 这两件事**都不会报错**：补丁悄悄睡去，而人只会在下一次「只有思考、没有输出」
// 时才发现 —— 那时又要从零排查一遍（2026-09-18 那次就是这么绕了一大圈）。
// ⇒ 补丁不能只在「应用的那一刻」存在，必须能被**定期复查**。
//
// 判据两条，分开报告，都不猜：
//   ① **在位**：目标文件里能否唯一命中原判据 / 补丁判据（纯文件，可靠）。
//   ② **生效**：Electron 单实例锁 `lockfile` 的 mtime == 主实例启动时刻。
//      它晚于补丁文件 mtime ⇒ 内核在补丁写入之后才加载 ⇒ 已生效。
//      ⚠️ 这是**启发式**：它假设「承载内核的是主实例」。实测 2026-09-18
//      lockfile 16:34:22 与主进程 StartTime 16:34:21 只差 1 秒 ⇒ 当前成立。
//      拿不到 lockfile 就报「无法判定」，**绝不推测**（H 节：别把假设当事实）。
//
// 为什么用 lockfile 而不是查进程：沙箱下**外部 exe 一律被拒**
//   （实测 `netstat -ano` → Program 'NETSTAT.EXE' failed to run: Access is denied），
//   而 Node 从脚本里 spawn `powershell.exe` 同样会被拒 ⇒ 自检**必须纯文件**才能走通。
//
// 实测（2026-09-19 07:47）：用户 07:44 重启 DSH ⇒ deepseek 补丁「✅ 已生效」；
//   而 07:47 刚写下的 pi-ai 补丁报「⏳ 未生效」—— 判据两次都给出可核对的具体时刻。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 内核运行期探测（内核加载时刻 / 热挂载记录 / profile 路径）—— 2026-09-19 拆出去独立成模块，
// 因为本文件已 88% 逼近行数预算，而"探测系统状态"与"审计并打印"本就是两件事。
import { readKernelBoot, readHotMounts, profilePackageJson } from './kernel-boot.mjs';

const CANDIDATE_APP_ROOTS = [
  'E:/3/DSH Desktop/resources/app',
  'C:/Program Files/DSH Desktop/resources/app',
];

// 补丁清单从 `_dsh_memory/patches.json` 读（**单一数据源**）—— 与打补丁脚本
// `tools/patch-dsh-empty-response.mjs` 共用同一份锚点串，避免两处各写一份而漂移。
const MEM_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function loadPatches() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(MEM_ROOT, 'patches.json'), 'utf8'));
    // ⚠️ `retired: true` 的条目**必须跳过**（2026-09-19 起两条内核补丁退役、改由 guardPlugins 承担）
    //    —— 不跳的话它们会被报成「未打或已丢失」，那是**误报**。
    const patches = (m.patches || []).filter((p) => !p.retired).map((p) => ({
      ...p,
      fix: `node E:\\2\\_dsh_memory\\tools\\patch-dsh-empty-response.mjs --apply --only ${p.id}`,
    }));
    return { patches, guardPlugins: m.guardPlugins || [] };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 防护插件是否真挂在 profile 的 `dsh.profile.bundles` 里。
 * ⚠️ 这是**内核补丁退役后**这一层的实际防线 —— 只装了包不算数，**bundles 里没有就是不加载**。
 * profile 目录名 `web` 是本机固定值；读不到就返回 null（不推测）。
 */
function auditGuardPlugins(list) {
  const pj = profilePackageJson();
  let bundles = null; let declaredAt = null;
  try {
    bundles = JSON.parse(fs.readFileSync(pj, 'utf8'))?.dsh?.profile?.bundles ?? [];
    declaredAt = fs.statSync(pj).mtimeMs;      // bundles 声明的最后改动时刻
  } catch { /* 保持 null */ }
  const hot = readHotMounts();                 // 热挂载记录 = "真的加载过"的直接证据
  const boot = readKernelBoot();
  return (list || []).map((g) => {
    const mounted = bundles === null ? null : bundles.includes(g.name);
    const hotAt = hot?.get(g.name) ?? null;
    // 「已加载」的两种证据（任一成立即可）：
    //   ① 日志里有过该包的**热挂载**记录（最直接）；
    //   ② 内核在**当前 bundles 声明之后**重启过 —— 那次重启就会按 bundles 把它加载进来。
    // 两者都拿不到 ⇒ loaded = null（判不了，**不推测**）。
    const byRestart = mounted === true && boot !== null && declaredAt !== null && boot.at >= declaredAt ? boot.at : null;
    const loaded = hotAt !== null ? hotAt : byRestart;
    return { name: g.name, why: g.why, mounted, loaded, via: hotAt !== null ? '热挂载' : (byRestart ? '重启后按 bundles' : null) };
  });
}

const countOf = (hay, needle) => hay.split(needle).length - 1;
const fmt = (ms) => {
  const d = new Date(ms); const z = (n) => String(n).padStart(2, '0');
  return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
};

/**
 * 体检外挂补丁：在位（文件级）+ 生效（启发式）。
 * ⚠️ 只读 —— 和 prune 一样「只报告不自动改」，补不补由人决定。
 * @param {{appRoots?: string[]}} [opts]
 * @returns {{items: Array, lock: {file:string,mtime:number}|null}}
 */
export function auditPatchStatus({ appRoots = CANDIDATE_APP_ROOTS } = {}) {
  const boot = readKernelBoot();
  const { patches, guardPlugins, error } = loadPatches();
  if (error) return { items: [], plugins: [], boot, manifestError: error };
  const items = patches.map((p) => {
    const target = appRoots.map((r) => path.join(r, p.rel)).find((f) => fs.existsSync(f)) ?? null;
    if (target === null) return { ...p, state: 'notfound', target: null };
    let src; let mtime = null;
    try { src = fs.readFileSync(target, 'utf8'); mtime = fs.statSync(target).mtimeMs; }
    catch (e) { return { ...p, state: 'unreadable', target, error: e.message }; }
    const nOld = countOf(src, p.oldLine);
    const nNew = countOf(src, p.newLine);
    const state = nNew === 1 && nOld === 0 ? 'applied'
      : nOld === 1 && nNew === 0 ? 'missing'
        : 'unknown';   // 两个锚点都不唯一命中 ⇒ 上游源码变了，需人工复核
    // 生效只在「在位」时才有意义；**内核加载**晚于补丁写入 ⇒ 已加载补丁
    const live = state === 'applied' && boot !== null && mtime !== null ? boot.at >= mtime : null;
    return { ...p, state, target, nOld, nNew, mtime, live };
  });
  return { items, plugins: auditGuardPlugins(guardPlugins), boot };
}

/**
 * 格式化成 `cli.mjs sweep` 要打印的行（打印留在本模块，避免 cli.mjs 撞行数预算）。
 * @param {ReturnType<typeof auditPatchStatus>} r
 * @returns {string[]} 每行一条
 */
export function formatPatchStatusReport(r) {
  if (r.manifestError) return [`⑥ 外挂补丁自检：⚠️ 补丁清单读不了（${r.manifestError}）—— 检查 _dsh_memory/patches.json`];
  const when = r.boot ? `内核加载 ${fmt(r.boot.at)}（${r.boot.src}）` : '内核加载时刻未知';
  const out = ['⑥ 外挂补丁自检（清单 `patches.json`；写在应用安装目录 ⇒ **升级即覆盖、不重启不生效**）：'];
  if (!r.items.length) out.push('   （内核补丁：无在册条目 —— 两条已 retired，改由下面的插件承担）');
  for (const it of r.items) {
    if (it.state === 'applied') {
      const eff = it.live === null ? '⚠️ 生效状态无法判定'
        : it.live ? '✅ 已生效' : '⏳ 未生效（补丁晚于进程启动 ⇒ 需重启 DSH 才生效）';
      out.push(`   ${eff}｜${it.title}`);
      if (it.live === false) out.push(`      ${when}，补丁写入 ${fmt(it.mtime)}`);
    } else if (it.state === 'missing') {
      out.push(`   ❌ 未打或已丢失（多半是被 DSH 升级覆盖）｜${it.title}`);
      out.push(`      → 重打：${it.fix}`);
    } else if (it.state === 'unknown') {
      out.push(`   ⚠️ 无法判定｜${it.title}`);
      out.push('      原判据与补丁判据都不唯一命中 ⇒ 上游源码可能已变，请人工复核 issue 里的根因段落');
    } else if (it.state === 'notfound') {
      out.push(`   ⚠️ 找不到目标文件（DSH 可能已卸载/换位置）｜${it.title}`);
    } else {
      out.push(`   ⚠️ 目标文件读不了（${it.error}）｜${it.title}`);
    }
  }
  for (const g of r.plugins || []) {
    const st = g.mounted === null ? '⚠️ 无法判定（读不到 profile 的 bundles）'
      : !g.mounted ? '❌ **未挂载**（bundles 里没有它 ⇒ 这层防护是空的）'
        : g.loaded !== null ? `✅ 已挂载且**已加载**（${g.via} ${fmt(g.loaded)}）`
          : '⚠️ 已挂载但**没有加载证据**（日志无热挂载、内核也早于声明 ⇒ 等下次重启）';
    out.push(`   ${st}｜${g.name}`);
  }
  if (r.boot) out.push(`   （生效判据：内核加载 ${fmt(r.boot.at)}［${r.boot.src}］ vs 补丁写入时刻）`);
  return out;
}
