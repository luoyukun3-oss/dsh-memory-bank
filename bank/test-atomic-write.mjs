// ============================================================================
// test-atomic-write.mjs —— 第 34 节：全量写必须是原子的（2026-11-08）
//
// 抄自 LivingMemory `core/validators/index_validator_rebuild.py` 的「影子 + 原子切换」纪律：
//   它建影子表 → 建好才 ALTER RENAME 切换 → `if not switched: DROP shadow`（线上一个字节不动）。
//   md + 文件系统的等价物 = **同目录临时文件 + rename**（同目录才能保证同一文件系统，rename 才原子）。
//
// 为什么这条值得一条测试（我们原来是裸 writeFileSync）：
//   `writeText`/`writeJson` 有 **48 个调用点**，覆盖 index.json / access.json / state.json /
//   journal / pages 全部落盘。裸写在「写到一半崩/被杀」时留下**半成品**：
//     · JSON 截断 ⇒ `readJson` 的 catch 把它当"空库"返回 ⇒ **静默变成空数据**
//     · md 截断 ⇒ 条目少一半，而且没人报错
//   这正好是我们今天踩过的形态（index.json 从 2288 掉到 1056、一度想不通为什么）。
//
// ⚠️ 前提实测过（win32 / Node 24.21.0）：`fs.renameSync(tmp, 已存在的目标)` **能覆盖**，
//   tmp 消失、内容为新。整个改法只在这条成立时才安全 —— 所以这里也把它钉成断言。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeText, writeJson, readJson } from './core.mjs';

/** 目录里除给定文件名之外的 `.tmp-*` 残留。 */
const tmpLeftovers = (dir, allowed = []) =>
  fs.readdirSync(dir).filter((f) => f.includes('.tmp-') && !allowed.includes(f));

export function runAtomicWriteTests({ ok }) {
  console.log('== 34. 全量写是原子的（tmp + rename），失败不留半成品（2026-11-08） ==');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-atomic-'));

  // ① 写文本：内容正确、无 tmp 残留
  {
    const f = path.join(T, 'a.txt');
    writeText(f, 'hello');
    ok(fs.readFileSync(f, 'utf8') === 'hello', 'writeText 内容正确');
    ok(tmpLeftovers(T).length === 0, `写完无 tmp 残留（实得 ${tmpLeftovers(T).join(',') || '无'}）`);
  }

  // ② 覆盖已存在文件（这条是前提：Windows rename 能覆盖）
  {
    const f = path.join(T, 'b.txt');
    writeText(f, 'OLD');
    writeText(f, 'NEW');
    ok(fs.readFileSync(f, 'utf8') === 'NEW', 'rename 能覆盖已存在文件，内容是新值');
    ok(tmpLeftovers(T).length === 0, '覆盖后同样无 tmp 残留');
  }

  // ③ JSON 往返
  {
    const f = path.join(T, 'c.json');
    writeJson(f, { docs: [1, 2, 3], updatedAt: 'x' });
    const back = readJson(f, null);
    ok(back && back.docs.length === 3, 'writeJson / readJson 往返正确');
    ok(fs.readFileSync(f, 'utf8').includes('\n  '), 'writeJson 仍是缩进 2 的空格排版（没被改坏）');
    ok(tmpLeftovers(T).length === 0, 'JSON 写完无 tmp 残留');
  }

  // ④ 写失败：抛错、原文件不变、不留 tmp
  {
    const blocker = path.join(T, 'blocker');
    fs.writeFileSync(blocker, 'i am a file, not a dir');
    const target = path.join(blocker, 'sub', 'x.txt');   // 父级是文件 ⇒ mkdir 必失败
    let threw = false;
    try { writeText(target, 'y'); } catch { threw = true; }
    ok(threw, '父路径不可建时**抛错**（不静默吞掉）');
    ok(fs.readFileSync(blocker, 'utf8') === 'i am a file, not a dir', '失败时既有文件内容没被破坏');
    ok(tmpLeftovers(T).length === 0, '失败路径也不留 tmp 垃圾');
  }

  // ⑤ 真·半成品证明：旧实现（裸 writeFileSync）在被中断时留下截断的 JSON；
  //    新实现因为先写 tmp，目标在 rename 前**始终是旧的完整内容**。
  //    这里用「mock 掉 rename 让它抛错」来模拟中断，断言目标仍是旧值。
  {
    const f = path.join(T, 'd.json');
    writeJson(f, { v: 'OLD-COMPLETE' });
    const before = fs.readFileSync(f, 'utf8');
    const origRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('模拟中断'); e.code = 'EINTR'; throw e; };
    let threw = false;
    try { writeJson(f, { v: 'NEW' }); } catch { threw = true; }
    fs.renameSync = origRename;                          // 立刻还原，别污染后面的断言
    ok(threw, '切换失败时抛错');
    ok(fs.readFileSync(f, 'utf8') === before, '切换失败时目标**仍是旧的完整内容**（不是半成品）');
    ok(readJson(f, null)?.v === 'OLD-COMPLETE', '而且旧内容仍能被正常解析（不是截断的 JSON）');
    ok(tmpLeftovers(T).length === 0, '中断路径也清理了 tmp');
  }

  fs.rmSync(T, { recursive: true, force: true });
}
