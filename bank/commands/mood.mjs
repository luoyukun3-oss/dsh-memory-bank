// 情绪系统 v2 的 CLI 子命令（2026-10-13）—— 从 cli.mjs **按域拆出**。
// 起因：cli.mjs 的行数预算 510、实测 506（99%），而 cli.mjs 自己在上轮（cue，10-13 上午）就写下了欠账：
//   「cli.mjs 454 行纯调度已接近巨石，**下次加命令前先按域拆**」。本轮加 mood 命令时兑现它。
// 约定：本文件**不 import cli.mjs**（避免循环依赖）；只接 cli 传进来的上下文（opt / log / dir / cwd）。
//
// ⚠️ 这里**没有 `audit` 子命令**（2026-10-13 当天加过又删掉）：那个审计扫的是本机会话日志，
//   而日志里说话的就是用户 ⇒ 等于把用户当成"施压来源"来统计，对象错了。理由见 mood.mjs 头注释。
import { MOOD_WEIGHT_NAMES, isDangerWeight, parseMoodWeight } from '../config-keys.mjs';
import { clearMood, currentMoodWeight, formatMoodReport, formatMoodWeightReport,
  loadMood, moodSnapshot, setMood, setMoodWeight } from '../mood.mjs';

/** 危险档告警（2026-11-09 兑现 todos：config-keys 早写明「界面/CLI 都要红字提示」而两侧都没实现 ⇒ 静默生效）。 */
const dangerWarn = (level) => (!isDangerWeight(level) ? null : [
  `🔴🔴 危险档「${MOOD_WEIGHT_NAMES[parseMoodWeight(level)]}」已启用 —— 它破掉情绪 v2 的两条地基：`,
  '   ① 气氛段**提前注入**（插到【全局偏好】之后 ⇒ 从"读完事实后的补充"变成"读事实前的定调"，典型 priming）',
  '   ② 允许**不带 --evidence 裸写气氛**（普通档一律拒写；裸写的每条打 unsafe:true 留痕，注入段会标出来）',
  '   ⚠️ 不破的那条：score（事实分）任何档位下**一个字都不许变**。退出危险档：cli mood weight mid',
].join('\n'));

/**
 * `cli mood [show|set|clear]`
 *   show  看当前气氛 + 历史（只读）
 *   set   写气氛 —— **必须带 --evidence（用户原话摘录）**；label 变了必须带 --reason（改口留痕）
 *   clear 清空气氛 —— 同样要 --reason
 */
export function runMoodCommand({ sub = 'show', arg, opt, log, dir }) {
  if (sub === 'show') {
    if (opt('json')) { log(JSON.stringify(moodSnapshot(dir), null, 2)); return; }
    // ⚠️ 第 2 个参数（档位）**必须传**（漏了只会静默按默认档渲染）；危险档时每次看都提醒，否则它会一直静默生效。
    const w = currentMoodWeight(dir);
    log(formatMoodReport(loadMood(dir), w)); const dw = dangerWarn(w); if (dw) log(dw);
    return;
  }
  if (sub === 'set') {
    try {
      const r = setMood(dir, {
        label: opt('label', ''), tone: opt('tone', ''), themes: opt('themes', ''),
        evidence: opt('evidence', ''), reason: opt('reason', ''), intensity: opt('intensity'),
        energy: opt('energy'), note: opt('note'),
        source: opt('source', 'infer'),
      });
      log(r.changed
        ? (r.record.from
          ? `气氛已更新：${r.record.from} → **${r.record.label}**（改口理由：${r.record.reason}）`
          : `气氛已设定：**${r.record.label}**（首条记录）`)
        : `气氛已刷新：${r.record.label}（标签未变，只更新了证据/强度）`);
      log(formatMoodReport(r.mood, currentMoodWeight(dir)));
      if (r.mood?.current?.unsafe) log('🔴 本条气氛是**危险档下裸写**的（没给 --evidence）⇒ 已打 unsafe:true 留痕，注入段会标出来。');   // 危险档允许裸写，必须当场说清
    } catch (e) { log(`❌ ${e.message}`); process.exitCode = 1; }
    return;
  }
  if (sub === 'clear') {
    try {
      const r = clearMood(dir, { reason: opt('reason', ''), evidence: opt('evidence', '') });
      log(r.changed ? '气氛已清空（历史里留了痕）' : '本来就没有气氛，无需清空');
    } catch (e) { log(`❌ ${e.message}`); process.exitCode = 1; }
    return;
  }
  // weight：权重档位（2026-10-13 晚新增）—— 用户要的「只要一个情绪权重，低/中/高几个选项」。
  //   不带参数＝看；带参数＝改。`cli mood weight 高` 与 `--level high` 两种写法都认。
  if (sub === 'weight') {
    try {
      const want = String(arg || opt('level', '') || '').trim();
      // `--json`：给界面/脚本用（无参数＝只读快照；带参数＝先写再回快照，只写一次）
      if (opt('json')) {
        log(JSON.stringify(want ? { ...moodSnapshot(dir), changed: setMoodWeight(dir, want).changed } : moodSnapshot(dir), null, 2));
        return;
      }
      if (!want) { log(formatMoodWeightReport(currentMoodWeight(dir))); return; }
      const r = setMoodWeight(dir, want);
      log(r.changed
        ? `权重档位已改为：**${MOOD_WEIGHT_NAMES[r.config.weight]}（${r.config.weight}）**`
        : `权重档位本来就是「${MOOD_WEIGHT_NAMES[r.config.weight]}」—— 没变`);
      log(formatMoodWeightReport(r.config.weight));
      const dw = dangerWarn(r.config.weight); if (dw) log(dw);   // ← 兑现「切到危险档必须醒目提示」
    } catch (e) { log(`❌ ${e.message}`); process.exitCode = 1; }
    return;
  }
  log('用法：cli mood [show] | weight [off|low|mid|high|关|低|中|高] | set --label X --evidence "主人原话" [--tone Y --themes a,b --reason Z --intensity 0.5 --energy 0-100 --note "此刻一句" --source user] | clear --reason Z');
}
