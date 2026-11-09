// ============================================================================
// test-arch.mjs —— 第 16/17 节：架构红线（2026-11-09 从 test.mjs 按域拆出）
//   为什么拆：test.mjs 实测 459/460 行（100%，下一条断言就爆）。按预算表规矩按域拆。
//   本文件管两件「约束类」断言：
//     第 16 节 零依赖红线（hook 跑在受限沙箱，第三方依赖缺失会**静默失败**）
//     第 17 节 配置键三处同步（登记表 / 消费点 / 文档一致 —— 纸面约定挡不住漂移）
//   ⚠️ 原代码在顶层用 `await import(...)`；搬到函数里会逼调用方也 await ⇒ 改**静态 import**，
//      config-keys 是纯常量模块、无副作用，静态加载安全。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { auditDependencies } from './dep-audit.mjs';
import * as ck from './config-keys.mjs';

export function runArchTests({ ok, memRoot, real }) {
  console.log('== 16. 零依赖红线（借自 dsh-pet：架构约束由测试守护） ==');
  // 起因：hook 跑在 DSH 受限沙箱里，第三方依赖一旦缺失就**静默失败**（注入消失比报错难查得多）；
  // 同时本轮把测试自身 `file:///E:/2/...` 的硬编码 import 改成相对路径 ⇒ 换目录不再自崩。
  const dep = auditDependencies();
  ok(dep.files >= 10, `扫了 ${dep.files} 个模块`);
  ok(dep.violations.length === 0, '没有第三方依赖 / 绝对路径 import',
    dep.violations.map((v) => `${v.file}:${v.line} → ${v.spec}`).join('; '));
  ok(dep.specifiers.every((s) => s.kind === 'builtin' || s.kind === 'relative'),
    `${dep.specifiers.length} 个依赖说明符全部合规（node: 内建 or 相对路径）`);

  console.log('== 17. 配置键三处同步（借 dsh-pet：新增键必须登记，值不许再写一遍） ==');
  // 起因是实测到的漂移：MIN_SCORE 于 2026-09-17 由 1.2 上调 1.5，可是 recall-eval 抄了一份
  // 靠行尾注释人肉对齐、bank.mjs 两处注释至今仍写着 1.2 —— 纸面约定（注释）挡不住漂移。
  // dsh-pet 的解法是「默认值 + 白名单 + 测试快照」三处登记，这里等价成「登记表 + 消费点 + 文档一致」。
  // config-keys 改为文件顶部静态 import（见文件头说明）
  const consumers = Object.entries(ck.CONSUMERS);
  ok(consumers.length >= 3, `登记表覆盖 ${consumers.length} 个配置键（值只在 config-keys.mjs 定义）`);
  const missRef = [];
  for (const [key, files] of consumers) {
    for (const f of files) {
      const src = fs.readFileSync(path.join(memRoot, f), 'utf8');
      if (!new RegExp(`\\b${key}\\b`).test(src)) missRef.push(`${f} 里找不到 ${key}`);
    }
  }
  ok(missRef.length === 0, '声明的消费点都真的引用了登记表（没退回硬编码）', missRef.join('; '));
  // 文档漂移是这类问题最常见的形态：文档里写的数字必须等于代码里的值
  const todoHead = fs.readFileSync(path.join(real, 'pages', 'todos.md'), 'utf8');
  const docBudget = Number((todoHead.match(/总预算\s*(\d+)\s*字/) || [])[1]);
  ok(docBudget === ck.INJECT_BUDGET, `todos.md 头写的总预算与登记表一致（文档 ${docBudget} / 代码 ${ck.INJECT_BUDGET}）`);
  // 2026-10-13 实测踩到：往 note 里插了一个半角双引号 ⇒ budgets.json 解析失败 ⇒ 而 `readJson(..., {}).budgets || {}`
  // **静默退化成「0 个文件」**，行数红线整条失效却不报错（当时唯一信号是断言总数 261→192）。这里专门盯它。
  let bj = {}; try { bj = JSON.parse(fs.readFileSync(path.join(memRoot, 'bank', 'budgets.json'), 'utf8')).budgets || {}; } catch { bj = {}; }
  ok(Object.keys(bj).length > 0, `budgets.json 能解析出 budgets 表（${Object.keys(bj).length} 项）—— 它坏掉会让行数红线**静默**失效`);
}
