// Memory Bank CLI
// init | remember | recall | ingest | reflect | status | page | migrate
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INJECT_BUDGET } from './config-keys.mjs';
import {
  slugOf, ensureRepo, repoDir, recall, ingest, reflect, bootstrapText, tidyRepo,
  reindexPage, readJson, writeJson, writeText, readText, zh, day, clip, syncFromMemory,
  listItems, archiveItems,
} from './bank.mjs';
import { runAuditCli } from './commands/audit.mjs';    // 体检族（2026-11-09 按域拆出）
import { verifyIndex, indexStatusLine } from './index-schema.mjs';   // 索引结构自检（2026-11-08）
import { findDreamPairs, formatDreamReport } from './dream.mjs';
import { runDreamInboxCommand } from './commands/dream-inbox.mjs';   // 收件箱命令（按域拆出，2026-10-18）
import { addMemo, doneMemo, listMemo } from './commands/memo.mjs';   // 备忘录（2026-10-18）
import { writeDay } from './commands/day.mjs';
import { writeHandoff } from './handoff.mjs';
// 召回诊断（2026-11-08 重写）：原 `summarizeOmissions/renderOmissions` 那条路一直是崩的
// —— `recall()` 根本没有 `explain` 参数，`res.omitted` 恒为 undefined。详见 explain.mjs 头注释。
import { explainQuery, formatExplain } from './explain.mjs';
// 逐条「命中来源」（2026-11-08）：只读 hit 自带的 `tokens` / `via` 反推，**不动 search.mjs 热路径**。
import { buildBasisCtx, describe, formatBasisFooter } from './explain-basis.mjs';
import { addWatch, applyIssue, clearPending, listWatch, formatWatchList, formatCheckLine } from './watch.mjs';
import { fetchWatchTarget } from './watch-target.mjs';
import { formatCueReport, loadCueTable, matchCues } from './cue.mjs';
import { runMoodCommand } from './commands/mood.mjs';   // 情绪系统 v2（2026-10-13，按域拆出）
import { runEvCommand } from './commands/ev.mjs';       // 事件存储 SQLite（2026-10-26）
import { runTickCommand } from './commands/tick.mjs';   // tick 主流程（2026-10-23 按域拆出）
import { runExtractCli } from './extract.mjs';          // LLM 抽取通道（2026-11-09）：只产 inbox 候选
import { runRemember } from './commands/remember.mjs';  // remember 域（2026-11-02 按域拆出，并接上事实键）
import { pruneLive } from './live.mjs';                // tidy 顺手清 live 过期会话状态（2026-10-29）
import { runRotateCommand } from './commands/rotate.mjs';   // 备份轮转（2026-11-09，按域拆出）
import { runRelCommand } from './commands/rel.mjs';         // 关系编辑（2026-11-09：手动连/断 rel 边）

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const args = argv.slice(1);
const opt = (name, fb) => { const i = args.indexOf(`--${name}`); return i === -1 ? fb : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const cwd = path.resolve(String(opt('cwd', process.env.CLAUDE_PROJECT_DIR || 'E:\\2')));
const slug = String(opt('slug', slugOf(cwd)));
const dir = ensureRepo(slug, cwd);
// 只收「无值」的裸参数：`--flag value` 里的 value 不算 positional。
// 否则 `remember "正文" --page x.md` 会把 `x.md` 拼进正文，写入内容被污染
// （AGENTS.md 推荐的就是这个写法，所以影响每一次规范写入）。
// 白名单列「布尔 flag」，其余 `--x` 一律视为带值；且仅当下一 token 不以 `--`
// 开头才跳过 —— 这样白名单漏了也只是多收一个参数，不会吞掉后面的 flag。
const BOOLEAN_FLAGS = new Set(['--json', '--full', '--apply', '--diff', '--split', '--both']);
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const next = args[i + 1];
  if (!BOOLEAN_FLAGS.has(a) && next !== void 0 && !next.startsWith('--')) i += 1;
}

function log(s) { process.stdout.write(s + '\n'); }

switch (cmd) {
  case 'init': {
    reindexAllPages();
    log(`记忆银行已就绪：${dir}`);
    break;
  }

  case 'remember': {
    // 2026-11-02 按域拆出到 commands/remember.mjs（cli.mjs 已 94%），并接上「事实键」(--key)。
    runRemember({ opt, log, dir, positional });
    break;
  }

  case 'recall': {
    const q = positional.join(' ') || String(opt('q', ''));
    const res = recall(dir, q, { k: Number(opt('k', 5)) });
    // 逐条 match_basis（笔记 15.7「哪条路在贡献，不必做 A/B」）：纯反推，不改 search() 热路径。
    // ⚠️ cue 不在里面 —— 它不是召回来源（只被 hook / cli cue 调用），理由见 explain-basis.mjs 头注释。
    const bctx = buildBasisCtx(dir, q);
    if (opt('json')) log(JSON.stringify(res.hits.map((h) => ({ title: h.title, kind: h.kind, page: h.page, score: Number(h.score.toFixed(3)), basis: describe(h, bctx).text, text: clip(h.text, 200) })), null, 2));
    else {
      log(res.text || '（记忆银行里没有相关内容）');
      const foot = formatBasisFooter(res.hits, bctx, { rendered: res.text });   // 逐条核对：命中 ≠ 看到
      if (foot.length) log(`\n${foot.join('\n')}`);
    }
    break;
  }

  case 'watch': {
    // 盯外部回复（2026-09-30 新增）：list（默认）| check | add <repo> <n> | read <repo> <n>
    // 渲染都在 watch.mjs 里（先例：dream / patch-status / dead-audit），这里只做分支调度。
    const sub = positional[0] || 'list';
    if (sub === 'add' || sub === 'read') {
      const repo = positional[1];
      const num = positional[2];
      if (!repo || !num) { log('用法：cli watch add|read <owner/repo> <number> [--label 说明] [--count N]'); break; }
      if (sub === 'add') {
        addWatch(void 0, { repo, number: num, label: typeof opt('label') === 'string' ? String(opt('label')) : null, lastCount: Number(opt('count', 0)) });
        log(`已登记 ${repo}#${num}`);
      } else log(`清掉 ${clearPending(void 0, repo, num)} 条未读（${repo}#${num}）`);
      break;
    }
    const items = listWatch(void 0);
    if (sub === 'check') {
      if (!items.length) { log('清单为空 —— 先 `cli watch add <owner/repo> <number>`'); break; }
      // 自己的 login：自己发的评论不算未读（见 watch.mjs 的 applyIssue 注释）
      const self = (() => { try { return String(spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).stdout || '').trim(); } catch { return ''; } })();
      for (const it of items) {
        const f = fetchWatchTarget(it.repo, it.number);   // 取回层在 watch-target.mjs：issue 优先，不是 issue 就当 discussion 查
        if (!f.ok) { log(`⚠️ ${it.label} 查询失败：${f.why}`); continue; }
        try { log(formatCheckLine(it, applyIssue(void 0, it.repo, it.number, f.v, self))); }
        catch (e) { log(`⚠️ ${it.label} 解析失败：${e.message}`); }
      }
      break;
    }
    log(formatWatchList(items));
    break;
  }

  case 'explain': {
    // 「这条为什么排在这里 / 为什么没上来」（2026-11-08 重写为可用版本）
    //   旧实现调 `recall(..., { explain: true })`，而 recall 没有该参数 ⇒ res.omitted 恒 undefined
    //   ⇒ `cli.mjs:114` 抛 TypeError，**这条命令从来没跑通过**。
    const q = positional.join(' ') || String(opt('q', ''));
    if (!q.trim()) { log('用法：cli.mjs explain "<查询>" [--k 5]'); break; }
    log(formatExplain(explainQuery(dir, q, { k: Number(opt('k', 5)) }), { k: Number(opt('k', 5)) }));
    break;
  }

  case 'ingest': {
    const r = ingest(dir, { transcript: typeof opt('transcript') === 'string' ? String(opt('transcript')) : null, cwd, full: !!opt('full') });
    log(`摄入完成：新增 ${r.added} 条用户记录；累计会话 ${r.sessions} 个 → ${dir}`);
    break;
  }

  case 'reflect': {
    const r = reflect(dir, { days: Number(opt('days', 7)) });
    log(`反思完成：${r.file}\n  主题 ${r.themes} 个｜教训候选 ${r.candidates} 条｜错误模式 ${r.errors} 种｜todos 未完成 ${r.openEnds} 条｜用户线索 ${r.openClues ?? 0} 条`);
    break;
  }

  // 体检族（2026-11-09 按域拆到 commands/audit.mjs）：sweep / lines / dead / lessons-audit。
  // 四个都是「只读 + 渲染」型（sweep 的 --apply 只归档已完成待办），回归面最小 ⇒ 最先拆。
  case 'sweep': case 'lines': case 'dead': case 'lessons-audit': {
    runAuditCli(cmd, { dir, cwd, log, opt, argv });
    break;
  }

  // dream：找「无共享标签、却共享罕见词」的条目对 —— 凝缩是**合并同类项**，做梦是**发现意外关联**。
  // 只报告、不自动改（同 prune 的默认 dry-run）：关联成不成立是判断，不是计算。人审后成立才建 rel: 边。
  case 'dream': {
    // `--json`：导出**全部**候选（默认只渲染前 LIMIT=20 条）。2026-10-13 加 —— 起因是候选已到 214 组，
    // 屏幕上只有 20 条，「人审」根本看不到清单；顺手也给「批量委派给子智能体审」准备了输入。
    // `--near`：另看「同日/相邻两天」档（默认不报，见 dream.mjs 的 same-event 分层注释）。
    const near = argv.includes('--near');
    // `--since 2026-10-23`：只看「任一端条目日期 ≥ 该日」的候选 —— 每日 19:30 扫当天用（2026-10-23 加）。
    const since = opt('since', null);
    const extra = { ...(near ? { near: true } : {}), ...(since ? { since: String(since) } : {}) };
    const r = findDreamPairs(dir, argv.includes('--json') ? { limit: Number.MAX_SAFE_INTEGER, near: true, ...extra } : extra);
    if (argv.includes('--json')) { log(JSON.stringify({ total: r.total, all: r.all, near: r.near, candidates: r.candidates })); break; }
    for (const line of formatDreamReport(r)) log(line);
    break;
  }

  // day：按天索引入口（2026-10-18）—— 生成 pages/days/YYYY-MM-DD.md，内部自带 reindex
  case 'day': { const sp = argv.includes('--split'); for (const d of (positional.length ? positional : [day()])) (sp ? writeDaySplit : writeDay)(dir, d, log); break; }
  // memo：助手备忘录（2026-10-18 用户定名）—— 记「商量过但还没动工的事」与「还没提交的 bug」，
  // 每条带**原话时间戳**；做完不删，移到末尾压成一行。实现在 bank/commands/memo.mjs。
  case 'memo': {
    const sub = String(positional[0] || 'list').toLowerCase();
    if (sub === 'add') { const r = addMemo(dir, positional.slice(1).join(' '), opt('at', null) || undefined); log(r.ok ? '已钉进备忘录' : `❌ ${r.reason}`); break; }
    if (sub === 'done') { const r = doneMemo(dir, positional[1], positional.slice(2).join(' ')); log(r.ok ? `已完成：${r.when} ${r.what}` : `❌ ${r.reason}`); break; }
    listMemo(dir, log);
    break;
  }


  // dream-inbox：做梦候选的收件箱（2026-10-18 用户拍板方案 A）—— 实现已按域拆到
  // bank/commands/dream-inbox.mjs（cli.mjs 加到 534/510 超限 ⇒ 按 budgets.json 的规矩拆，别压缩行宽硬塞）。
  case 'dream-inbox': {
    runDreamInboxCommand({ positional, argv, dir, log });
    break;
  }

  // handoff：看一眼「跨会话交接」当前抓到什么（默认只读不写；--write 才重新生成）
  // 为什么要单独给命令：`tick` 会覆盖它，出问题时得能**不惊动 tick** 地复看与重算。
  case 'handoff': {
    const r = writeHandoff(dir, { cwd, write: !!opt('write'), turns: Number(opt('turns', undefined)) || undefined });
    if (!r.ok) { log(`交接：跳过（${r.reason}）`); break; }
    log(`交接：${r.turns} 轮 / 正文 ${r.chars} 字（含表头共 ${r.fileChars} 字｜源 ${r.label}）${opt('write') ? '｜已写入' : '｜仅预演（加 --write 才落盘）'}`);
    for (const line of String(r.text).split('\n')) log(line);
    break;
  }

  // tick：给计划任务用的一键动作 = 增量摄入 + 深度反思 + 整理 +（可选）刷新旧版记忆库
  // 2026-10-23 **按域拆到 commands/tick.mjs**（cli.mjs 489/510 逼近红线），并给每段加了
  // 计时 + 失败隔离；handoff/sweep 带 stamp（不再每 30 分钟重算同一份没变的东西）。
  case 'tick': {
    runTickCommand({ opt, dir, cwd, log });
    break;
  }

  // extract：LLM 从会话日志里抽候选 —— **产出只进 pages/inbox.md**（未经验证、不进召回），
  //   晋升仍靠人审。⚠️ 为什么是独立子命令、而不是默认接进 tick：LLM 调用有网络延迟与成本，
  //   而 tick 每 30 分钟跑一次 ⇒ 一天 48 次调用，成本与耗时都不可控（tick 实测总共 15 秒）。
  //   先让人手动跑几轮看质量，再由主人决定要不要放进计划任务（`cli extract` 无参数即抽最近会话）。
  case 'extract': {
    await runExtractCli({ opt, log, dir, cwd, positional });
    break;
  }

  // tidy：定期维护 —— 归档已完成项、去重、压缩空行，让会话注入的索引保持干净
  case 'tidy': {
    const r = tidyRepo(dir);
    if (r.skipped) { log('没有 pages/todos.md，跳过'); break; }
    log(`整理完成：归档已完成 ${r.items ?? r.moved} 条（含续行 ${r.moved} 行）｜剩余未完成 ${r.open} 条｜正文 ${r.before} → ${r.after} 字`);
    if (r.archive) log(`  归档到：${r.archive}`);
    const pr = pruneLive();   // 2026-10-29：live/ 过期会话状态（同 tick ④b；pruneLive 原先从无调用点）
    if (pr) log(`  清 live：${pr} 个过期会话状态`);
    break;
  }

  // sync：检查/修复 MEMORY.md 与知识页的共享章节（默认只报告；覆盖必须指定方向）
  case 'sync': {
    const apply = !!opt('apply');
    const from = String(opt('from', 'memory'));
    const diff = !!opt('diff');
    const force = !!opt('force');   // 2026-11-08：允许覆盖「页面独有的行」（默认拒绝，见 bank.mjs 该处注释）
    const only = opt('only', null);
    const r = syncFromMemory(dir, { apply, from, withDiff: true, force, only: only ? String(only).split(',').map((s) => s.trim()).filter(Boolean) : null });
    if (!r.ok) { log('找不到 MEMORY.md，跳过同步'); break; }
    const dirTxt = from === 'page' ? '知识页 → MEMORY.md' : 'MEMORY.md → 知识页';
    log(`主干同步（${apply ? `已写入：${dirTxt}` : '仅检查，不写入'}）：${r.drift ? `${r.drift} 处不一致` : '全部一致'}`);
    for (const x of r.report) {
      // 2026-11-08：`page-only-would-be-lost` 是**拒绝写**（不是写完才报警），图标用 🛑 与普通 ⚠️ 区分
      const icon = x.status === 'in-sync' ? '✅'
        : (x.status === 'page-only-would-be-lost' ? '🛑' : (apply ? '✏️' : '⚠️'));
      const size = x.chars === undefined ? '' : `  MEMORY ${x.chars} 字 / 页面 ${x.pageChars} 字`;
      log(`  ${icon} ${x.page} ‹${x.section}› ${x.status}${size}`);
      if (x.status === 'page-only-would-be-lost') {
        // 把「会丢哪几行」直接摆出来 —— 光说"会丢 N 行"没人会去看
        log(`      ⚠️ 页面有 ${x.pageOnly.length} 行 MEMORY 里没有，反向覆盖会**抹掉它们**，已拒绝写入。`);
        for (const l of x.pageOnly.slice(0, 5)) log(`        ${l.slice(0, 110)}`);
        if (x.pageOnly.length > 5) log(`        …另有 ${x.pageOnly.length - 5} 行`);
        log(`      做法：① 反向同步保内容 → sync --apply --from page（把页面这几行带回 MEMORY）`);
        log(`            ② 或者确认可以丢 → sync --apply --force（显式放弃这 ${x.pageOnly.length} 行）`);
      }
      if (diff && x.status !== 'in-sync' && x.status !== 'page-only-would-be-lost') {
        const show = (arr, tag) => {
          if (!arr || !arr.length) return;
          log(`      ${tag}（${arr.length} 行）：`);
          for (const l of arr.slice(0, 6)) log(`        ${l.slice(0, 110)}`);
          if (arr.length > 6) log(`        …另有 ${arr.length - 6} 行`);
        };
        show(x.memoryOnly, '仅 MEMORY 有');
        show(x.pageOnly, '仅页面有');
      }
    }
    if (r.drift && !apply) log('  → 看差异：sync --diff　　覆盖：sync --apply --from memory（或 --from page，覆盖前自动备份）');
    break;
  }

  // preview：打印新会话开场会注入什么（改记忆结构后必看）
  case 'preview': {
    const ctx = bootstrapText(dir, { budget: Number(opt('budget', INJECT_BUDGET)) });
    log(`— 新会话开场注入（${ctx.length} 字）—`);
    // 分段账本（2026-09-15 新增）：按【标题】切分统计，预算超没超一眼可见
    const segs = ctx.split(/\n(?=【)/);
    let sum = 0;
    for (const s of segs) {
      const name = (s.match(/^【([^】]+)】/) || [, '（开头段）'])[1];
      sum += s.length;
      log(`  · ${name} ${'·'.repeat(Math.max(1, Math.round(s.length / 40)))} ${s.length} 字`);
    }
    log(`  ── 合计 ${sum} 字 / 预算 ${Number(opt('budget', INJECT_BUDGET))} 字`);
    log('');
    log(ctx);
    break;
  }

  // rotate：备份文件轮转（2026-11-09）。默认 **dry-run**；实现在 commands/rotate.mjs（按域拆出，本文件 510 行上限）
  case 'rotate': {
    runRotateCommand({ opt, log });
    break;
  }

  case 'status': {
    const meta = readJson(path.join(dir, 'bank.json'), {});
    const pages = fs.existsSync(path.join(dir, 'pages'))
      ? fs.readdirSync(path.join(dir, 'pages')).filter((f) => f.endsWith('.md') && !f.includes('.bak-'))
      : [];
    const idx = readJson(path.join(dir, 'index.json'), { docs: [] });
    const jr = fs.existsSync(path.join(dir, 'journal')) ? fs.readdirSync(path.join(dir, 'journal')) : [];
    const rf = fs.existsSync(path.join(dir, 'reflections')) ? fs.readdirSync(path.join(dir, 'reflections')) : [];
    log(`仓库：${meta.cwd || cwd}（slug=${slug}）`);
    log(`  目录：${dir}`);
    log(`  会话：${Object.keys(meta.sessions || {}).length}　索引文档：${(idx.docs || []).length}　知识页：${pages.length}　流水：${jr.length}　反思：${rf.length}`);
    log(`  上次摄入：${meta.lastIngestAt ? zh(new Date(meta.lastIngestAt)) : '从未'}　上次反思：${meta.lastReflectAt ? zh(new Date(meta.lastReflectAt)) : '从未'}`);
    try {
      const sc = syncFromMemory(dir, { apply: false });
      if (sc.ok) log(`  主干同步：${sc.drift ? `${sc.drift} 处与 MEMORY.md 不一致（跑 sync 看详情）` : '与 MEMORY.md 一致'}`);
    } catch { /* 同步检查失败不影响 status */ }
    log('  知识页：' + pages.join('、'));
    // 索引结构自检（2026-11-08）：版本号 + stats 自洽性。**只报不修** ——
    // 索引可以从 pages/*.md 完全重建，所以"修"永远是 `cli init`，不是自动迁移。
    try {
      const v = verifyIndex(dir);
      log(`  索引自检：${indexStatusLine(dir)}`);
      for (const p of v.problems) log(`    ⚠️ ${p}`);
    } catch (e) { log(`  索引自检：检查本身失败（${e.message}）`); }
    break;
  }

  case 'page': {
    const name = positional[0] || 'todos.md';
    log(readText(path.join(dir, 'pages', name)) || `（没有 pages/${name}）`);
    break;
  }

  case 'migrate': {
    const mem = readText('E:/2/_dsh_memory/MEMORY.md');
    const idxmd = readText('E:/2/_dsh_memory/INDEX.md');
    const sections = mem.split(/\n(?=##\s)/).map((s) => s.trim()).filter(Boolean);
    const mapping = {
      '主人（用户）画像': ['preferences.md', true],
      '环境信息': ['environment.md', false],
      '进行中 / 待办': ['todos.md', false],
      '故障备忘（速查）': ['faults.md', false],
      '变更记录': ['changelog.md', false],
      '记忆系统（本目录）': ['meta.md', false],
      '恢复会话的方法': ['meta.md', false],
      '助手的工作习惯（保持一致性）': ['preferences.md', true],
    };
    let n = 0;
    const buckets = new Map();
    for (const sec of sections) {
      const title = (sec.match(/^##\s*(.+)$/m) || [, ''])[1].trim();
      const hit = Object.entries(mapping).find(([k]) => title.includes(k));
      const [page, isGlobal] = hit ? hit[1] : ['meta.md', false];
      buckets.set(page, (buckets.get(page) || '') + `\n## ${title}\n` + sec.replace(/^##\s*.+$/m, '').trim() + '\n');
      if (isGlobal) {
        const g = repoDir('_global');
        ensureRepo('_global', null);
        const gf = path.join(g, 'pages', 'preferences.md');
        writeText(gf, (readText(gf) || '# 全局偏好（跨仓库）\n') + `\n## ${title}\n` + sec.replace(/^##\s*.+$/m, '').trim() + '\n');
        reindexPage(g, 'preferences.md');
      }
      n++;
    }
    for (const [page, body] of buckets) {
      const f = path.join(dir, 'pages', page);
      const head = readText(f) || `# ${page.replace('.md', '')}\n`;
      writeText(f, head + body);
      reindexPage(dir, page);
    }
    // 文件索引页
    writeText(path.join(dir, 'pages', 'index-files.md'), '# 工作区文件索引\n\n' + idxmd.replace(/^#.*\n/, ''));
    reindexPage(dir, 'index-files.md');
    log(`迁移完成：${n} 个章节 → ${buckets.size + 1} 个知识页（另有 _global/pages/preferences.md）`);
    break;
  }

  // items：列出条目清单 + 已有评分，供人工判断「哪些可以退场」（默认只报告）
  case 'items': {
    const page = typeof opt('page') === 'string' ? String(opt('page')) : null;
    const rows = listItems(dir, page ? { page } : {});
    if (opt('json')) { log(JSON.stringify(rows.map(({ raw, ...r }) => r), null, 2)); break; }
    log(`共 ${rows.length} 条${page ? `（仅 ${page}）` : ''}｜i = 已标注的重要度（1~5，空=未标）｜len = 字符数`);
    log('');
    log('| 页 | 行 | i | 日期 | len | 条目 |');
    log('|---|---|---|---|---|---|');
    for (const r of rows) log(`| ${r.page} | ${r.line} | ${r.i ?? ''} | ${r.date ?? ''} | ${r.len} | ${r.title} |`);
    break;
  }

  // prune：把低价值条目**移**到 pages/archive.md（不进检索/注入），默认 dry-run
  case 'prune': {
    const page = typeof opt('page') === 'string' ? String(opt('page')) : null;
    const match = typeof opt('match') === 'string' ? String(opt('match')) : null;
    const r = archiveItems(dir, { page, pattern: match, apply: !!opt('apply') });
    if (r.error) { log(`✗ ${r.error}`); break; }
    if (!r.moved.length) { log(`没有条目匹配 ${match}`); break; }
    log(`${r.apply ? '已移档' : '【dry-run】将移档'} ${r.moved.length} 条 → pages/archive.md`);
    for (const m of r.moved) log(`  - ${clip(m.replace(/\s+/g, ' '), 100)}`);
    if (r.apply) {
      log(`\n备份：${r.backup}`);
      log(`归档：${r.archive}（在 ARCHIVED_PAGES 里 → 不进检索池、不进注入）`);
    } else {
      log('\n确认无误后加 --apply 执行（会先写 pages/_bak/ 快照）');
    }
    break;
  }

  // cue：看「触发式联想」会带出什么（2026-10-13 新增；只读观测，不写记忆、不动索引）
  case 'cue': {
    const text = positional.join(' ') || String(opt('text', ''));
    if (!text) { log('用法：cli cue "<文本>" [--mode prompt|output] [--rebuild] [--json]'); break; }
    const t = loadCueTable(dir, null, { rebuild: !!opt('rebuild') });
    const mode = String(opt('mode', 'prompt'));
    const hits = matchCues(t, text, mode);
    log(opt('json')
      ? JSON.stringify(hits.map((h) => ({ word: h.word, level: h.level, page: h.entry.page, title: h.entry.title })), null, 2)
      : formatCueReport(t, hits, mode));
    break;
  }

  // mood：情绪系统 v2（2026-10-13）—— 实现按域拆到 commands/mood.mjs（cli.mjs 行数预算已到 99%，上轮欠账兑现）
  case 'mood': {
    runMoodCommand({ sub: positional[0] || 'show', arg: positional[1], opt, log, dir, cwd });
    break;
  }

  // rel：关系编辑（2026-11-09）—— 此前手改 rel 边必须记 tools/ 下 4 个脚本的参数，没有「顺手连一条」的入口。
  //     add/rm **默认 dry-run**，`--apply` 才写；`--both` 双向。实现在 commands/rel.mjs。
  case 'rel': {
    runRelCommand({ sub: positional[0] || 'list', positional, opt, log, dir });
    break;
  }

  // ev：事件存储（SQLite，2026-10-26）—— 事件实体化/关联/联想的第一层。
  //     ⚠️ md 仍是权威：import 从 events.md 全量重建，可反复跑；库里写了不回流。
  case 'ev': {
    runEvCommand({ sub: positional[0] || 'stats', arg: positional[1], opt, log, dir, cwd });
    break;
  }

  default:
    log('用法：init | remember "内容" [--page x.md] | recall "查询" | cue "文本" [--mode prompt|output] | mood [show|weight|set|clear] | ev [import|list|search|related|entity|stats] | ingest [--full] | reflect | tick [--quick] [--last] | extract [--write] [--max N] [--session 文件] | tidy | sweep [--apply] | handoff [--write] | lines | dead | rel [list|add|rm] | rotate [--apply] [--keep N] | sync [--apply] [--force] [--only <页>] | preview | status | page <文件> | items [--page x.md] | prune --page x.md --match "正则" [--apply] | dream | migrate');
}

function reindexAllPages() {
  const pd = path.join(dir, 'pages');
  if (!fs.existsSync(pd)) return;
  for (const f of fs.readdirSync(pd).filter((x) => x.endsWith('.md'))) reindexPage(dir, f);
}
