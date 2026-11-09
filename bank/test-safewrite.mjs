// ============================================================================
// test-safewrite.mjs —— 第 29 节：并发安全的读-改-写（2026-11-08）
//
// 起因：GitHub 讨论区回复指出「后台整理读完一页后用户又手动改了，最终以哪版为准」。
// 实测复现：旧写法（读全文 → 改 → 写全文）在「读之后、写之前」这个窗口里
//   会**静默覆盖**用户的手改，且无任何提示。
//
// 本节守四条不变量：
//   ① 无并发时正常写
//   ② 读后写前有人改过 ⇒ 重读重做，两边都不丢
//   ③ 目标节已被别人改掉 ⇒ 拒绝写（不硬覆盖），报 target-missing
//   ④ 持续冲突 ⇒ 放弃且不写坏文件
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mutateFile, replaceSectionSafely, fingerprintOf } from './safe-write.mjs';

export function runSafeWriteTests({ ok }) {
  console.log('== 29. 并发安全的读-改-写（2026-11-08，讨论区指出 sync 会静默覆盖用户手改） ==');
  const T = path.join(os.tmpdir(), 'mb-safewrite-' + process.pid);
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(T, { recursive: true });
  const f = path.join(T, 'page.md');
  const base = '# demo\n\n## 节A\n旧A\n\n## 节B\n旧B\n';

  // ① 无并发：正常写
  fs.writeFileSync(f, base);
  const r1 = mutateFile(f, (t) => t.replace('旧A', '新A'));
  ok(r1.written && fs.readFileSync(f, 'utf8').includes('新A'), '① 无并发时正常写入');

  // ② 读后写前被外部改过 ⇒ 重读重做，用户编辑与本次修改都在
  fs.writeFileSync(f, base);
  let injected = false;
  const r2 = mutateFile(f, (t) => {
    if (!injected) { injected = true; fs.writeFileSync(f, t.replace('旧B', '用户手改B ★')); }
    return t.replace('旧A', '新A');
  });
  const t2 = fs.readFileSync(f, 'utf8');
  ok(r2.written && r2.retries >= 1, '② 检测到并发后重做（retries ≥ 1）');
  ok(t2.includes('用户手改B ★'), '② 用户那次编辑**没被覆盖**（旧写法会丢）');
  ok(t2.includes('新A'), '② 后台整理也生效（两边都不丢）');

  // ③ 目标节已被改掉 ⇒ 拒绝写
  fs.writeFileSync(f, base);
  const oldSec = '## 节A\n旧A\n';
  fs.writeFileSync(f, base.replace(oldSec, '## 节A\n用户已改\n'));
  const r3 = replaceSectionSafely(f, oldSec, '## 节A\n新A\n');
  ok(!r3.written && r3.reason === 'target-missing', '③ 目标节已变 ⇒ 拒绝写并报 target-missing');
  ok(fs.readFileSync(f, 'utf8').includes('用户已改'), '③ 用户内容原样保留');

  // ④ 持续冲突 ⇒ 放弃且文件完整
  fs.writeFileSync(f, base);
  let n = 0;
  const r4 = mutateFile(f, (t) => { fs.writeFileSync(f, t + `<!-- x${++n} -->\n`); return t.replace('旧A', '新A'); }, { retries: 2 });
  ok(!r4.written && r4.reason === 'conflict-give-up', '④ 持续冲突 ⇒ 放弃（不硬写）');
  ok(fs.readFileSync(f, 'utf8').includes('# demo'), '④ 放弃后文件仍完整');

  // ⑤ 无改动不写盘（mtime 不变）
  fs.writeFileSync(f, base);
  const m0 = fs.statSync(f).mtimeMs;
  const r5 = mutateFile(f, (t) => t);
  ok(!r5.written && r5.reason === 'no-change' && fs.statSync(f).mtimeMs === m0, '⑤ 无需改动时不写盘');

  // ⑥ 指纹函数稳定（同一内容同指纹、不同内容不同指纹）
  ok(fingerprintOf('abc') === fingerprintOf('abc') && fingerprintOf('abc') !== fingerprintOf('abd'), '⑥ 指纹稳定且能区分内容');

  fs.rmSync(T, { recursive: true, force: true });
}
