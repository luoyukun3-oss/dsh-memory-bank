// dream-apply —— 把「裁决」安全落库：预检 → 加锁 → rel-apply → 改状态 → 记账本（2026-10-18）
// 为什么单开模块：`apply` 从 dream-inbox.mjs 按域拆出（那边已到 98% 预算），而且它同时治三个真实缺陷：
//  ① **「approved 但没边」**：rel-apply 定位不到 key 时只 skip、退出码仍是 0，原实现照样标 approved；
//  ② **无互斥**：load→改→save 无锁，两个进程同时 apply 会丢更新（2026-10-18 实测有三个子代理同时写）；
//  ③ **无账本**：出问题无法回放（mneme 有 dream_runs 三合一账本，我们只有一条 key 列表）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fp, loadInbox, renderInboxMd, saveInbox } from './dream-inbox.mjs';

export const REL_TYPES = new Set(['causal', 'sequence', 'scenario', 'attribute', 'preference']);
const LOCK = '.dream-inbox.lock';
/** 锁超过这么久算死锁（先 rename 隔离再重试；cc-haha 的做法：不直接删，留证据）。 */
const STALE_MS = 5 * 60 * 1000;

/** 预检：**一条不合法就整批不写**（cc-haha 的 preflight；我们原来是逐条落，前 29 条已脏）。 */
function preflight(dir, verdicts) {
  const box = loadInbox(dir);
  const known = new Set((box.items || []).map((it) => it.key));
  const errors = [];
  const warns = [];
  if (!Array.isArray(verdicts)) return { ok: false, errors: ['裁决文件不是 JSON 数组'], warns };
  const seen = new Set();
  verdicts.forEach((v, i) => {
    const at = '第 ' + (i + 1) + ' 条';
    const a = String((v && v.a) || '');
    const b = String((v && v.b) || '');
    if (!a.includes('#') || !b.includes('#')) { errors.push(at + '：a/b 必须形如 页名#序号（收到 ' + a + ' / ' + b + '）'); return; }
    if (v.verdict !== 'yes' && v.verdict !== 'no') { errors.push(at + '：verdict 只能是 yes/no（收到 ' + v.verdict + '）'); return; }
    if (v.type && !REL_TYPES.has(String(v.type))) { errors.push(at + '：type "' + v.type + '" 不在白名单（' + [...REL_TYPES].join('/') + '）'); return; }
    const k = fp(a, b);
    if (seen.has(k)) { errors.push(at + '：同一对出现两次（' + k + '）'); return; }
    seen.add(k);
    if (!known.has(k)) {
      if (v.verdict === 'yes') errors.push(at + '：yes 的 ' + k + ' 不在收件箱里（无从建边）');
      else warns.push(at + '：no 的 ' + k + ' 不在收件箱里（已忽略）');
    }
  });
  return { ok: errors.length === 0, errors, warns };
}

/** 拿锁：`open(wx)` 原子建；死锁先 rename 隔离再重试。 */
function acquireLock(dir) {
  const f = path.join(dir, LOCK);
  const take = () => {
    const fd = fs.openSync(f, 'wx');
    fs.writeSync(fd, process.pid + ':' + Date.now());
    fs.closeSync(fd);
  };
  try { take(); return { ok: true, file: f }; } catch (e) {
    if (e.code !== 'EEXIST') return { ok: false, reason: e.message };
    let age = 0;
    try { age = Date.now() - fs.statSync(f).mtimeMs; } catch { /* 刚被删 */ }
    if (age < STALE_MS) return { ok: false, reason: '另一个 apply 正在跑（锁 ' + f + '，' + Math.round(age / 1000) + 's 前建立）' };
    try { fs.renameSync(f, f + '.stale-' + Date.now()); } catch { /* ignore */ }
    try { take(); return { ok: true, file: f }; } catch (e2) { return { ok: false, reason: '死锁清理后仍拿不到：' + e2.message }; }
  }
}
function releaseLock(file) { try { fs.unlinkSync(file); } catch { /* ignore */ } }

/** run 账本（mneme 的 dream_runs 简化版，一行一次）。写不进就静默 —— 账本不能拖垮主流程。 */
function appendRun(dir, row) {
  try { fs.appendFileSync(path.join(dir, 'dream-runs.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', 'utf8'); } catch { /* ignore */ }
}

/** 按裁决更新状态；`failed` 是 Map(key → 原因)：yes 但建边失败的标 approved-failed，不谎报成功。 */
export function applyVerdicts(dir, verdicts, { dry = false, failed = new Map() } = {}) {
  const box = loadInbox(dir);
  const byKey = new Map((box.items || []).map((it) => [it.key, it]));
  let yes = 0; let no = 0; let miss = 0; let failedN = 0;
  for (const v of (Array.isArray(verdicts) ? verdicts : [])) {
    const key = fp(String(v.a || ''), String(v.b || ''));
    const it = byKey.get(key);
    if (!it) { miss++; continue; }
    if (v.verdict === 'yes') {
      if (failed.has(key)) { it.status = 'approved-failed'; it.applyError = failed.get(key); failedN++; }
      else { it.status = 'approved'; it.relType = v.type || null; delete it.applyError; yes++; }
    } else if (v.verdict === 'no') { it.status = 'rejected'; no++; }
  }
  // ⚠️ 干跑**不写任何文件**（与 rel-apply 干跑语义一致；2026-10-18 修过一次「文案说没动，实际写了」）。
  if (dry) return { yes, no, miss, failed: failedN };
  box.updatedAt = new Date().toISOString();
  saveInbox(dir, box);
  renderInboxMd(dir, box);
  return { yes, no, miss, failed: failedN };
}

/** 从 rel-apply 的「跳过」段解析出 key → 原因。 */
function parseSkipped(out) {
  const m = new Map();
  for (const line of String(out || '').split('\n')) {
    const hit = /(\S+#\d+)\s*×\s*(\S+#\d+)\s*[（(]([^）)]*)/.exec(line);
    if (hit && /跳过|定位|无法/.test(line)) m.set(fp(hit[1], hit[2]), hit[3].trim());
  }
  return m;
}

/**
 * 一站式：预检 → 锁 → rel-apply → 改状态 → 账本。
 * @param {string} dir 仓库目录
 * @param {string} file 裁决 JSON 的绝对路径（rel-apply 要读它）
 * @param {Array} verdicts 已解析的裁决数组
 */
export function applyWithLedger(dir, file, verdicts, { dry = false } = {}) {
  const t0 = Date.now();
  const pre = preflight(dir, verdicts);
  if (!pre.ok) return { ok: false, errors: pre.errors, warns: pre.warns };
  if (dry) {
    const st = applyVerdicts(dir, verdicts, { dry: true });
    return { ok: true, dry: true, ...st, warns: pre.warns, relApply: null };
  }
  const lock = acquireLock(dir);
  if (!lock.ok) return { ok: false, errors: [lock.reason] };
  let st; let rr; let skipped = new Map();
  try {
    const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'rel-apply.mjs');
    rr = spawnSync(process.execPath, [tool, file, '--apply', '--repo', dir], { encoding: 'utf8' });
    skipped = parseSkipped(rr.stdout);
    st = applyVerdicts(dir, verdicts, { failed: skipped });
  } finally {
    releaseLock(lock.file);
  }
  appendRun(dir, {
    kind: 'apply', verdicts: path.basename(file),
    yes: st.yes, no: st.no, failed: st.failed, skipped: skipped.size,
    relApplyExit: rr ? rr.status : null, durationMs: Date.now() - t0,
  });
  return { ok: true, ...st, skipped: [...skipped.entries()], relOut: String((rr && rr.stdout) || '').trim(), warns: pre.warns };
}
