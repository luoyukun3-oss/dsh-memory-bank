// ============================================================================
// Memory Bank · commands/rotate —— `cli rotate` 子命令（2026-11-09 从 cli.mjs 按域拆出）
//
// 拆出的原因：cli.mjs 加了这段后 513/510 超限。按项目原则「只许瘦不许胖，超限先按域拆分」
// （先例：commands/mood.mjs / commands/memo.mjs / commands/dream-inbox.mjs）。
//
// ⚠️ 这是**删文件**的命令，默认必须 dry-run。真删只在 `--apply` 时发生。
// 只处理自动产物；`_bak/` 下的人工快照由 bak-rotate.mjs 在扫描阶段就分出去，永不进删除名单。
// ============================================================================
import { scanBackups, planRotation, applyRotation, KEEP_PER_FILE, KEEP_DAILY_DAYS } from '../bak-rotate.mjs';
import { MEM_ROOT } from '../live.mjs';

const mb = (n) => (n / 1024 / 1024).toFixed(1);
const sum = (arr) => arr.reduce((a, r) => a + r.size, 0);

/**
 * @param {{opt:Function, log:Function}} ctx
 */
export function runRotateCommand({ opt, log }) {
  const apply = !!opt('apply');
  const keep = Number(opt('keep', KEEP_PER_FILE));
  const days = Number(opt('days', KEEP_DAILY_DAYS));
  const { auto, manual } = scanBackups(MEM_ROOT);
  const plan = planRotation(auto, { keepPerFile: keep, keepDailyDays: days });

  log(`备份轮转（${apply ? '**已删除**' : 'dry-run，不删任何文件'}）：每文件保留最近 ${keep} 份 ∪ 每天最后一份（${days} 天内）`);
  log(`  自动产物 ${auto.length} 个 / ${mb(sum(auto))} MB`);
  log(`  保留 ${plan.keep.length} 个 / ${mb(sum(plan.keep))} MB ｜ ${apply ? '已删' : '将删'} ${plan.del.length} 个 / ${mb(sum(plan.del))} MB`);
  log(`  人工快照（_bak/）${manual.length} 个 / ${mb(sum(manual))} MB —— **不在轮转范围**`);

  const top = [...plan.del].sort((a, b) => b.size - a.size).slice(0, 8);
  if (top.length) {
    log('  最大几笔：');
    for (const r of top) log(`    ${r.rel.padEnd(52)} ${mb(r.size)} MB`);
    if (plan.del.length > top.length) log(`    …另有 ${plan.del.length - top.length} 个`);
  }
  if (!apply && plan.del.length) log('  → 确认无误后执行：cli rotate --apply');
  if (apply) {
    const res = applyRotation(plan, { apply: true });
    log(`  实际删除 ${res.deleted} 个 / ${mb(res.bytes)} MB${res.skipped ? `（${res.skipped} 个跳过）` : ''}`);
  }
}
