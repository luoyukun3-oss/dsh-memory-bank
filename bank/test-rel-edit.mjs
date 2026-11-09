// ============================================================================
// test-rel-edit.mjs —— `cli rel` 的守护（2026-11-09）
//
// 跑法：
//   node -e "import('./test-rel-edit.mjs').then(m=>m.runRelEditTests({ok:(c,l,d)=>console.log(c?'OK':'FAIL',l,c?'':(' << '+d))}))"
//
// 两层：
//   ① **纯函数**打 `applyRelOp`（加/删/幂等/三形态）与 `parseRef`/`keyProblem`；
//   ② **临时目录端到端**：造一个假 repo（只有 pages/*.md + index.json），跑 `runRelCommand`
//      的 dry-run / apply / rm，断言文件真的变了（或没变）。**绝不碰真实 pages/**。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRelOp, keyProblem, parseRef, runRelCommand } from './commands/rel.mjs';

const mkOpt = (o = {}) => (n, fb) => (n in o ? o[n] : fb);

/** 造一个最小假 repo：pages/fake.md 三个条目 + index.json 的 docs（检索端判据要用）。 */
function mkFakeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reltest-'));
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  const md = [
    '# fake',
    '',
    '- 第一条：闰年判断 <!-- i:4 -->',
    '- 第二条：性能排查',
    '- 第三条：备份轮转 <!-- rel:fake.md:第一条 -->',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'pages', 'fake.md'), md, 'utf8');
  const docs = [
    { id: 'fake.md#1', page: 'fake.md', title: '第一条：闰年判断', text: '第一条：闰年判断' },
    { id: 'fake.md#2', page: 'fake.md', title: '第二条：性能排查', text: '第二条：性能排查' },
    { id: 'fake.md#3', page: 'fake.md', title: '第三条：备份轮转', text: '第三条：备份轮转' },
  ];
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ docs }), 'utf8');
  return dir;
}
const readFake = (dir) => fs.readFileSync(path.join(dir, 'pages', 'fake.md'), 'utf8');

export function runRelEditTests({ ok }) {
  console.log('== 41. cli rel 关系编辑：list/add/rm（2026-11-09） ==');
  // —— ① 纯函数 ——
  const pr = parseRef('lessons.md:闰年');
  ok(pr && pr.page === 'lessons.md' && pr.kw === '闰年', 'parseRef 拆出页与关键词');
  ok(parseRef('lessons') === null && parseRef('lessons.md:') === null && parseRef(':x') === null, 'parseRef 对缺页/缺词/缺冒号返回 null');
  ok(parseRef('a.md:b:c').kw === 'b:c', 'parseRef 只按第一个冒号切（关键词里的冒号留在 kw 里，交给 keyProblem 拦）');
  ok(keyProblem('闰年') === null, '正常关键词无问题');
  ok(/空白/.test(keyProblem('闰 年')), '含空白被拦（注释按空白切分，会切碎）');
  ok(/逗号/.test(keyProblem('a,b')), '含逗号被拦（多值分隔符）');
  ok(/冒号/.test(keyProblem('a:b')), '含冒号被拦（类型分隔符）');
  ok(/太短/.test(keyProblem('闰')), '单字被拦（无法唯一定位）');

  // —— ② applyRelOp 三形态 + 删 ——
  const L = {
    plain: '- 只有正文',
    other: '- 有别的元数据 <!-- i:4 -->',
    hasRel: '- 已有边 <!-- rel:x.md:甲 -->',
    multi: '- 多条边 <!-- i:5 rel:x.md:甲,y.md:乙:causal -->',
    onlyRel: '- 只有一条边 <!-- rel:x.md:甲 -->',
  };
  let r = applyRelOp(L.plain, { val: 'rel:f.md:乙', op: 'add' });
  ok(r.changed && r.line === '- 只有正文 <!-- rel:f.md:乙 -->', '形态①：无注释 ⇒ 追加完整注释块', r.line);
  r = applyRelOp(L.other, { val: 'rel:f.md:乙', op: 'add' });
  ok(r.changed && r.line === '- 有别的元数据 <!-- i:4 rel:f.md:乙 -->', '形态②：有别的元数据 ⇒ 塞进同一注释（单空格）', r.line);
  r = applyRelOp(L.hasRel, { val: 'rel:f.md:乙', op: 'add' });
  ok(r.changed && r.line === '- 已有边 <!-- rel:x.md:甲,f.md:乙 -->', '形态③：已有 rel ⇒ 逗号追加（只有一个 rel: 前缀）', r.line);
  r = applyRelOp(L.hasRel, { val: 'rel:x.md:甲', op: 'add' });
  ok(!r.changed && /已存在/.test(r.why), '重复加同一条边 ⇒ 幂等不改（不写第二份）');
  r = applyRelOp(L.multi, { val: 'rel:x.md:甲', op: 'rm' });
  ok(r.changed && r.line === '- 多条边 <!-- i:5 rel:y.md:乙:causal -->', 'rm 删中间一条：保留其余与其它元数据', r.line);
  r = applyRelOp(L.onlyRel, { val: 'rel:x.md:甲', op: 'rm' });
  ok(r.changed && r.line === '- 只有一条边', 'rm 删到空 ⇒ 连注释块一起清掉（不留空 rel: 与空注释）', r.line);
  r = applyRelOp(L.multi, { val: 'rel:z.md:丙', op: 'rm' });
  ok(!r.changed && /没有这条边/.test(r.why), 'rm 目标边不存在 ⇒ 不改并说明原因');
  r = applyRelOp(L.onlyRel, { val: 'rel:x.md:甲:causal', op: 'rm' });
  ok(!r.changed, 'rm 按「边体完全相等」匹配：类型不符不误删无类型的那条');

  // —— ③ 端到端（假 repo）——
  const dir = mkFakeRepo();
  const before = readFake(dir);
  const outs = [];
  const log = (s) => outs.push(String(s));
  const run = (sub, positional, o = {}) => {
    outs.length = 0;
    process.exitCode = 0;
    runRelCommand({ sub, positional: [sub, ...positional], opt: mkOpt(o), log, dir });
    return outs.join('\n');
  };

  // list：一开始只有第三条上的 1 条边
  let out = run('list', []);
  ok(/共 \*\*1\*\* 条/.test(out), 'list 数出假 repo 里的 1 条边', out.split('\n')[0]);
  ok(/坏边 \*\*0\*\* 条/.test(out), 'list 判定该边目标可达（fake.md:第一条 在 docs 里）', out.split('\n')[0]);

  // add 的 dry-run：必须**一个字节都不改**
  out = run('add', ['fake.md:第二条', 'causal', 'fake.md:第一条']);
  ok(/dry-run/.test(out) && /rel:fake\.md:第一条:causal/.test(out), 'add 默认 dry-run 并打印将要写入的边', out);
  ok(readFake(dir) === before, 'add 的 dry-run 一个字节都没写（文件未变）');

  // add --apply：真写 + 备份
  out = run('add', ['fake.md:第二条', 'causal', 'fake.md:第一条'], { apply: true });
  const afterAdd = readFake(dir);
  ok(afterAdd.includes('- 第二条：性能排查 <!-- rel:fake.md:第一条:causal -->'), 'add --apply 真的写进了页面（形态①）', afterAdd);
  ok(fs.readdirSync(path.join(dir, 'pages')).some((f) => f.startsWith('fake.md.bak-rel-')), 'add --apply 先写了 .bak-rel-<ts> 备份');
  ok(/reindex-page\.mjs/.test(out), 'add --apply 提示下一步必须 reindex（否则索引里 meta.rel 还是旧的）');

  // add 的类型校验
  out = run('add', ['fake.md:第二条', '乱写', 'fake.md:第一条']);
  ok(/不合法/.test(out) && process.exitCode === 2, '非法类型被拒（并列出合法类型）', out.split('\n')[0]);

  // add 的目标必须能被检索端定位
  out = run('add', ['fake.md:第二条', 'causal', 'fake.md:不存在的条目']);
  ok(/找不到/.test(out) && process.exitCode === 1, '目标定位不到 ⇒ 拒绝并给出候选', out.split('\n')[0]);

  // rm dry-run 再 apply
  const beforeRm = readFake(dir);
  out = run('rm', ['fake.md:第二条', 'causal', 'fake.md:第一条']);
  ok(/dry-run/.test(out), 'rm 默认 dry-run');
  ok(readFake(dir) === beforeRm, 'rm 的 dry-run 不写文件');
  run('rm', ['fake.md:第二条', 'causal', 'fake.md:第一条'], { apply: true });
  ok(readFake(dir) === before, 'rm --apply 后文件回到 add 之前的原文（加/删可逆）', readFake(dir));

  // 多值 + 双向
  const dir2 = mkFakeRepo();
  const outs2 = [];
  const run2 = (sub, positional, o = {}) => {
    outs2.length = 0;
    process.exitCode = 0;
    runRelCommand({ sub, positional: [sub, ...positional], opt: mkOpt(o), log: (s) => outs2.push(String(s)), dir: dir2 });
    return outs2.join('\n');
  };
  run2('add', ['fake.md:第二条', 'sequence', 'fake.md:第一条'], { apply: true, both: true });
  const d2 = readFake(dir2);
  ok(d2.includes('- 第二条：性能排查 <!-- rel:fake.md:第一条:sequence -->'), '--both：源端写上', d2);
  ok(d2.includes('- 第一条：闰年判断 <!-- i:4 rel:fake.md:第二条:sequence -->'), '--both：目标端也写上（反向边，塞进原有 i:4 注释）', d2);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  process.exitCode = 0;
}
