// ============================================================================
// test-access-decay.mjs —— 第 31 节：软遗忘必须按「召回时间」衰减，不能按「索引重建时间」
//
// 守的是什么（2026-11-08 实测出来的）：
//   `search.mjs` 原本写 `const last = Math.max(access[d.id] || 0, Date.parse(d.updated) || 0)`。
//   而 `d.updated` 是**索引重建时间**、不是内容更新时间 —— 同一个文件的第 168 行注释早就写明了这点，
//   却在衰减处又用了它。后果：只要某页被重新索引过（每天往 events/decisions 写条目就会触发），
//   该页**所有**条目的 updated 都变成"现在" ⇒ `Math.max` 把「25 天没被想起」掩盖成「几乎全新」。
//
//   构造实测（改写前的代码）：access 25 天前 + updated 0.1 天前 ⇒ 旧式乘子 **0.992**，
//   只用 access 是 **0.382**。差距 0.61 倍。
//
// 为什么这条值得一条测试：它**当天影响为 0**（真实库里 123 条走衰减的条目中，
//   `access < updated` 的有 0 条 —— 纯属巧合，因为 stream/mild 页最近没被重建索引）。
//   也就是说，没有这条断言的话，这个 bug 要等到某天索引重建后才会暴露，
//   而那时现象是「老条目突然变高分」，极难归因。
//
// ⚠️ 造数据必须带 `tokens` 字段：`search()` 的打分完全依赖 `d.tokens`（不是 `d.text`），
//   缺了它所有文档都会在 `if (!covered && !extHit) continue;` 被跳过、结果恒空。
//   （写这条测试时第一版就栽在这里，hits 一直是空数组。）
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { search } from './search.mjs';
import { tokenize } from './core.mjs';

const DAY = 86400000;

/** 造临时银行 + 两条内容相同的条目（只有 id 不同），返回 { tmp, ids }。 */
function makeBank({ accessOldMs, accessNewMs, updatedMs, page = 'decisions.md' }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-decay-'));
  const now = Date.now();
  const mk = (id, text) => ({
    id, page, kind: 'page', title: id, text,
    tokens: tokenize(text),                      // ⚠️ 必须：search() 只认 tokens
    updated: new Date(updatedMs(now)).toISOString(),
  });
  // 两条正文**只差最后一个字**，保证 token 集合完全相同 ⇒ 基础分相同，差异只来自衰减
  const docs = [mk(`${page}#1`, '测试关键词 甲'), mk(`${page}#2`, '测试关键词 乙')];
  fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify({ docs, updatedAt: new Date(now).toISOString() }));
  fs.writeFileSync(path.join(tmp, 'access.json'), JSON.stringify({
    [`${page}#1`]: accessOldMs(now),
    [`${page}#2`]: accessNewMs(now),
  }));
  return { tmp, ids: [`${page}#1`, `${page}#2`] };
}

const scoreOf = (hits, id) => hits.find((h) => h.id === id)?.score;

export function runAccessDecayTests({ ok }) {
  console.log('== 31. 软遗忘按「召回时间」衰减，不能按「索引重建时间」（2026-11-08） ==');
  // ① 核心：updated 都很新（模拟刚重建索引），只有 access 有差别 ⇒ 衰减必须跟着 access 走
  {
    const { tmp, ids } = makeBank({
      accessOldMs: (now) => now - 25 * DAY,      // 25 天没被召回
      accessNewMs: (now) => now,                 // 刚刚被召回
      updatedMs: (now) => now - 0.1 * DAY,       // 但两条的索引时间都是 0.1 天前
    });
    const hits = search(tmp, '测试关键词', 5);
    const [oldS, newS] = ids.map((id) => scoreOf(hits, id));
    ok(oldS !== undefined && newS !== undefined, '两条都进了结果（否则没法比较）');
    if (oldS !== undefined && newS !== undefined) {
      ok(newS > oldS * 1.5,
        `刚召回的条目分数明显高于 25 天没召回的（${newS.toFixed(3)} vs ${oldS.toFixed(3)}，${(newS / oldS).toFixed(2)}×）`,
        '若比值 ≈ 1，说明衰减用的是 updated（索引重建时间），而不是 access（召回时间）');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ② 反向：access 比 updated 新（正常情况）⇒ 应该用 access，行为与改前一致
  {
    const { tmp, ids } = makeBank({
      accessOldMs: (now) => now - 3 * DAY,
      accessNewMs: (now) => now,
      updatedMs: (now) => now - 20 * DAY,        // 索引很旧，但两条都刚召回过/三天前召回过
    });
    const hits = search(tmp, '测试关键词', 5);
    const [s1, s2] = ids.map((id) => scoreOf(hits, id));
    ok(s1 !== undefined && s2 !== undefined && s2 > s1, 'access 新的仍排前（这条改动没有把正常情况改坏）');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ③ 没有 access 记录 ⇒ 退回 updated，不能崩、也不能把条目丢掉
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-decay-'));
    const now = Date.now();
    const mk = (id, text) => ({
      id, page: 'decisions.md', kind: 'page', title: id, text,
      tokens: tokenize(text), updated: new Date(now - 5 * DAY).toISOString(),
    });
    fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify({
      docs: [mk('decisions.md#1', '测试关键词 甲')], updatedAt: new Date(now).toISOString(),
    }));
    fs.writeFileSync(path.join(tmp, 'access.json'), '{}');
    const hits = search(tmp, '测试关键词', 5);
    ok(hits.length === 1, `无 access 记录时条目照常返回（实得 ${hits.length} 条）`);
    ok(hits[0] && hits[0].score > 0, '无 access 记录时分数为正（退回 updated，不是归零）');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ④ 两种情况的分差要合理：25 天 vs 刚召回，比值应落在 1.5~4 之间
  //    （下限 1.5 保证衰减确实生效；上限 4 防止有人把软遗忘改成硬遗忘 —— 硬遗忘会违背
  //     「一个月前的事永远想不起来」那条设计初衷，见 search.mjs 里「下限 0.35」的注释）
  {
    const { tmp, ids } = makeBank({
      accessOldMs: (now) => now - 25 * DAY,
      accessNewMs: (now) => now,
      updatedMs: (now) => now - 0.1 * DAY,
    });
    const hits = search(tmp, '测试关键词', 5);
    const [oldS, newS] = ids.map((id) => scoreOf(hits, id));
    if (oldS && newS) {
      const ratio = newS / oldS;
      ok(ratio >= 1.5 && ratio <= 4,
        `衰减幅度合理（${ratio.toFixed(2)}×，应在 1.5~4 之间）—— 既不能无效，也不能变成硬遗忘`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
