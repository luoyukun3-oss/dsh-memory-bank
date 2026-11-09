// ============================================================================
// test-sync-guard.mjs —— 第 33 节：`sync --apply` 不许静默抹掉「页面独有的行」（2026-11-08）
//
// 为什么这条是**真事故换来的**，不是假想：
//   2026-11-08 19:57:58 有人跑了默认方向的 `sync --apply --from memory`，
//   把 `changelog.md` 的「变更记录」整节覆盖成 MEMORY 版
//   ⇒ **抹掉 7 条页面独有记录、6266 字**（只活在 `changelog.md.bak-20261108115758` 里；
//     `.gitignore` 把 `repos/` 排除了，git 也救不回来）。
//
//   而当时已有的 `safe-write.mjs` 并发保护**挡不住**它 —— 它只拦「读之后到写之前有人改过」，
//   那次没人并发改 ⇒ `cur.raw === oldRaw` 成立 ⇒ 直接覆盖。
//   **并发安全 ≠ 语义安全**：前者防"同时改"，后者防"单向覆盖本来就该保留的东西"。
//
//   修法判据用现成的 `lineDiff().pageOnly`（＝页面有、MEMORY 没有的行）：
//   有 pageOnly 且方向是 MEMORY→页面 ⇒ **拒绝写**，除非显式 `force`。
//
// ⚠️ 全程在临时目录造数据，不碰真实银行里的 `MEMORY.md` 与 `repos\<slug>\pages\*`。
//   本测试第一版曾误改真库（`--repo` 参数没生效），现在只用 `syncFromMemory` 的 `memoryFile` 参数 + 临时 repo 目录。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncFromMemory } from './bank.mjs';

/** 造一个临时库：MEMORY 一节 + 页面一节（页面可多几行）。 */
function makePair({ pageExtraLines = [] } = {}) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-syncguard-'));
  const repo = path.join(T, 'repo');
  fs.mkdirSync(path.join(repo, 'pages'), { recursive: true });
  const memSection = [
    '## 9. 变更记录',
    '- 2026-11-08 只有 MEMORY 才有的条目',
    '- 2026-10-23 两边都有的条目',
    '',
  ].join('\n');
  const pageSection = [
    '## 9. 变更记录',
    '- 2026-11-08 只有 MEMORY 才有的条目',
    '- 2026-10-23 两边都有的条目',
    ...pageExtraLines,
    '',
  ].join('\n');
  const memFile = path.join(T, 'MEMORY.md');
  fs.writeFileSync(memFile, '# 长期记忆\n\n' + memSection, 'utf8');
  const pageFile = path.join(repo, 'pages', 'changelog.md');
  fs.writeFileSync(pageFile, '# changelog\n\n' + pageSection, 'utf8');
  return { T, repo, memFile, pageFile };
}

const statusOf = (r, page = 'changelog.md') => r.report.find((x) => x.page === page)?.status;

export function runSyncGuardTests({ ok }) {
  console.log('== 33. sync --apply 不许抹掉「页面独有的行」（2026-11-08，真丢过 6266 字） ==');
  // ① 页面有独有行 ⇒ 默认 --apply 必须拒绝，且**页面内容一个字都不能变**
  {
    const { T, repo, memFile, pageFile } = makePair({
      pageExtraLines: ['- 2026-11-08 【页面独有 A】只写在页面里', '- 2026-11-08 【页面独有 B】也只写在页面里'],
    });
    const before = fs.readFileSync(pageFile, 'utf8');
    const r = syncFromMemory(repo, { memoryFile: memFile, apply: true, from: 'memory' });
    const after = fs.readFileSync(pageFile, 'utf8');
    ok(statusOf(r) === 'page-only-would-be-lost', `状态是 page-only-would-be-lost（实得 ${statusOf(r)}）`);
    ok(before === after, '页面内容**一字未变**（拒绝写在写之前，不是写完再报警）');
    ok(after.includes('页面独有 A') && after.includes('页面独有 B'), '两条页面独有行都还在');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ② 显式 force ⇒ 允许覆盖（人要能看到代价并明确放弃）
  {
    const { T, repo, memFile, pageFile } = makePair({
      pageExtraLines: ['- 2026-11-08 【页面独有 A】只写在页面里'],
    });
    const r = syncFromMemory(repo, { memoryFile: memFile, apply: true, from: 'memory', force: true });
    const after = fs.readFileSync(pageFile, 'utf8');
    ok(statusOf(r) === 'updated', `force 时状态是 updated（实得 ${statusOf(r)}）`);
    ok(!after.includes('页面独有 A'), 'force 下页面独有行确实被覆盖（这是 owner 明确同意的代价）');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ③ 页面没有独有行 ⇒ 正常写入，不能被保护误伤
  {
    const { T, repo, memFile, pageFile } = makePair({ pageExtraLines: [] });
    // 先造一个「只有 MEMORY 有新行」的差异
    fs.writeFileSync(pageFile, '# changelog\n\n## 9. 变更记录\n- 2026-10-23 两边都有的条目\n', 'utf8');
    const r = syncFromMemory(repo, { memoryFile: memFile, apply: true, from: 'memory' });
    const after = fs.readFileSync(pageFile, 'utf8');
    ok(statusOf(r) === 'updated', `无 pageOnly 时正常 updated（实得 ${statusOf(r)}）`);
    ok(after.includes('只有 MEMORY 才有的条目'), 'MEMORY 的新行确实写进了页面');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ④ 反方向（--from page）不该被这条保护拦住 —— 它本来就是用来「把页面独有内容带回去」的
  {
    const { T, repo, memFile, pageFile } = makePair({
      pageExtraLines: ['- 2026-11-08 【页面独有 A】只写在页面里'],
    });
    const r = syncFromMemory(repo, { memoryFile: memFile, apply: true, from: 'page' });
    const memAfter = fs.readFileSync(memFile, 'utf8');
    ok(statusOf(r) !== 'page-only-would-be-lost', `--from page 不被拦（实得 ${statusOf(r)}）`);
    ok(memAfter.includes('页面独有 A'), '页面独有行被带回了 MEMORY（这是补救路径，必须通）');
    fs.rmSync(T, { recursive: true, force: true });
  }
}
