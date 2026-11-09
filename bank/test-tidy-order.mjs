// ============================================================================
// test-tidy-order.mjs —— 第 39 节：tidy 的写序必须是「先归档、后删源」（2026-11-08）
//
// 为什么这条值得一条测试（它是本模块**唯一不可自愈**的一处）：
//   原写序：先写 `todos.md`（已完成项已删）→ 再写 `todos-archive.md`。
//   崩在中间 ⇒ 源页那批条目**已经没了、归档里又还没有** ⇒ **永久蒸发**，没有第二次机会。
//   反过来之后同样的崩 ⇒ 归档里已经写了、源页也还在 ⇒ **重复**，看得见、可以人工去重。
//
// 判据：**重复优于丢失** —— 重复是可见可修的，丢失是不可逆的。
//
// ⚠️ 怎么造「崩在中间」：`writeText` 是 tmp + rename（原子写），所以只要让**写 todos.md 那一次的
//   rename 抛错**，就精确模拟了"归档已写、源页未写"。用 `todos.md` 精确匹配，不误伤
//   `todos-archive.md`（后者结尾是 `archive.md`，`endsWith('todos.md')` 为 false）。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tidyRepo } from './bank.mjs';

/** 造临时库：todos.md 含 1 条已完成 + 1 条未完成。 */
function makeBank() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-tidy-'));
  fs.mkdirSync(path.join(T, 'pages'), { recursive: true });
  fs.writeFileSync(path.join(T, 'index.json'), JSON.stringify({ docs: [], schemaVersion: 1 }), 'utf8');
  fs.writeFileSync(path.join(T, 'pages', 'todos.md'), [
    '# 待办', '',
    '- [x] 已完成的条目甲（应当被归档）', '',
    '- [ ] 未完成的条目乙（应当留在原页）', '',
  ].join('\n'), 'utf8');
  return T;
}

export function runTidyOrderTests({ ok }) {
  console.log('== 39. tidy 写序：先归档后删源，崩在中间只重复不丢失（2026-11-08） ==');

  // ① 正常路径：归档里有、原页没有
  {
    const T = makeBank();
    const r = tidyRepo(T);
    const todos = fs.readFileSync(path.join(T, 'pages', 'todos.md'), 'utf8');
    const arch = fs.readFileSync(path.join(T, 'pages', 'todos-archive.md'), 'utf8');
    ok(r.moved >= 1, `正常 tidy 归档了 ${r.moved} 条`);
    ok(arch.includes('已完成的条目甲'), '归档页里有那条已完成项');
    ok(!todos.includes('已完成的条目甲'), '原页里已经没有它（正常路径下应当移除）');
    ok(todos.includes('未完成的条目乙'), '未完成项留在原页');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ② 核心：模拟「归档写完、写源页时崩」⇒ 两边都在（重复，而不是丢失）
  {
    const T = makeBank();
    const origRename = fs.renameSync;
    fs.renameSync = function (from, to) {
      // 精确匹配「写源页」那一步；`todos-archive.md` 不匹配（结尾是 archive.md）
      if (String(to).endsWith(path.sep + 'todos.md')) {
        const e = new Error('模拟中断：写源页时进程被杀'); e.code = 'EINTR'; throw e;
      }
      return origRename(from, to);
    };
    let threw = false;
    try { tidyRepo(T); } catch { threw = true; }
    fs.renameSync = origRename;   // 立刻还原，别污染后面的断言

    const todos = fs.readFileSync(path.join(T, 'pages', 'todos.md'), 'utf8');
    const archPath = path.join(T, 'pages', 'todos-archive.md');
    const arch = fs.existsSync(archPath) ? fs.readFileSync(archPath, 'utf8') : '';

    ok(threw, '写源页失败时确实抛错（不静默吞掉）');
    ok(arch.includes('已完成的条目甲'), '**归档里已经有了**（先写归档 ⇒ 数据已落地）');
    ok(todos.includes('已完成的条目甲'), '**源页里也还在**（后写源页 ⇒ 没被删）');
    ok(arch.includes('已完成的条目甲') && todos.includes('已完成的条目甲'),
      '⇒ 结果是**重复**（可见可修），不是**丢失**（不可逆）—— 这就是交换写序的价值');
    fs.rmSync(T, { recursive: true, force: true });
  }

  // ③ 反向对照：如果写序是「先删源、后归档」，同样的中断会**永久丢**。
  //    这里不真的改代码（那要 monkey-patch 整个函数），只断言「归档在实际改动前就已落盘」这一事实：
  //    通过 mtime/内容先后无法直接观测，所以改为断言「源页在归档存在之前没被写」——
  //    用 mock 记录两次 writeText 的目标顺序。
  {
    const T = makeBank();
    const order = [];
    const origRename = fs.renameSync;
    fs.renameSync = function (from, to) {
      const b = path.basename(String(to));
      if (b === 'todos.md' || b === 'todos-archive.md') order.push(b);
      return origRename(from, to);
    };
    try { tidyRepo(T); } finally { fs.renameSync = origRename; }
    ok(order.includes('todos-archive.md') && order.includes('todos.md'), `两次写都发生了（${order.join(' → ')}）`);
    ok(order.indexOf('todos-archive.md') < order.indexOf('todos.md'),
      `归档**先于**源页写入（实际顺序：${order.join(' → ')}）—— 这是本节守的核心`);
    fs.rmSync(T, { recursive: true, force: true });
  }
}
