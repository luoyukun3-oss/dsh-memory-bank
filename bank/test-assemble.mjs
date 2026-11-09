// ============================================================================
// test-assemble.mjs —— 第 29 节：召回预算装配（2026-11-08，随 recall-assemble.mjs 落地）
//
// 守的是什么：**"预算装不下时，条目不该整条消失"**。
//   旧实现 `if (used + seg.length > budget && lines.length > 1) continue;` 会整条丢弃 ——
//   实测 18/18 条相关提问都有候选被丢，且丢时预算常常没花完（743/1100、784/1100）。
//   这几条断言直接把"丢"和"超"两种退化钉死：
//     ① 预算够时，**每条**都得出现（不许丢）；
//     ② 预算紧时，**至少**前 MIN_ITEM 字 + 截断标注都得在（不许无声消失）；
//     ③ 任何情况下 `join('\n').length <= budget`（不许撑破预算）。
//
// ⚠️ 为什么这里用**构造的假命中**而不是真库：真库内容天天变，断言会随数据漂移；
//   而这条逻辑的正确性只跟"长度"有关，与内容无关。
// ============================================================================
import { assemble } from './recall-assemble.mjs';

/** 造一条假命中：正文长度可控。⚠️ 正文必须**带换行**——cutText 按行边界截，
 *  纯单行正文会走它的兜底分支（返回 slice(0,n)+标记，比 n 还长），那是另一条路径，
 *  用单行造数据会把这条测试测成"cutText 的行为"而不是"装配的行为"。 */
const hit = (page, len, kind = 'page') => ({
  page, kind, title: `标题-${page}`,
  text: Array.from({ length: Math.ceil(len / 20) }, (_, i) => `第${i}行` + '甲'.repeat(16)).join('\n').slice(0, len),
});

export function runAssembleTests({ ok }) {
  console.log('== 29. 召回预算装配：装不下要降级，不许整条消失（2026-11-08，recall-assemble.mjs） ==');
  // ① 预算够：5 条短候选全都要在
  {
    const hits = [hit('a.md', 80), hit('b.md', 90), hit('c.md', 100), hit('d.md', 70), hit('e.md', 60)];
    const { lines } = assemble(hits, { budget: 2000 });
    ok(lines.length === 5, `预算充足时 5 条全部注入（实得 ${lines.length} 条）`);
  }

  // ② 预算紧：长候选被切成前缀 + 标注，而不是整条消失
  //   ⚠️ 预算**必须给够**：3 条 × (标题 16 + 前缀 60 + 两条标记约 45) ≈ 360 是下限，
  //   给 1100 时三条都在；但**只有"装不下整条"的那几条**才带 `cli page` 标注 ——
  //   装得下整条的走 cutText 自己的「…（已截断，完整内容见对应文件）」（它没有页名）。
  //   所以断言写成"每条都至少带一种截断标记"，别要求每条都带页名标注。
  {
    const hits = [hit('a.md', 900), hit('b.md', 900), hit('c.md', 900)];
    const { lines } = assemble(hits, { budget: 1100 });
    ok(lines.length === 3, `预算 1100 / 3 条长候选 ⇒ 3 条都还在（实得 ${lines.length} 条）`);
    ok(lines.every((l) => l.includes('已截断') || l.includes('cli page ')),
      '每条降级产物都带截断标记（不许无声消失）');
    ok(lines.some((l) => l.includes('cli page ')),
      '至少有一条走"按份额降级"路径并标出页名（稳定坐标，不是条目 id）');
  }

  // ③ 总长永不超预算（含 join 的连接符）
  {
    for (const budget of [300, 700, 1100, 1500]) {
      const hits = Array.from({ length: 6 }, (_, i) => hit(`p${i}.md`, 200 + i * 150));
      const { lines } = assemble(hits, { budget });
      ok(lines.join('\n').length <= budget,
        `budget=${budget} 时总长 ${lines.join('\n').length} ≤ ${budget}（连接符也算）`);
    }
  }

  // ④ 短候选用不满份额 ⇒ 额度流给后面的长候选（不是平均主义）
  {
    const hits = [hit('short.md', 30), hit('long.md', 1200)];
    const { lines } = assemble(hits, { budget: 800 });
    const longLine = lines.find((l) => l.includes('long.md')) || '';
    ok(longLine.length > 300, `短条目让出的额度给了长条目（长条目实得 ${longLine.length} 字）`);
  }

  // ⑤ 连前缀都放不下 ⇒ 跳过（不输出半截标题），且不能因此把预算撑破
  {
    const hits = [hit('a.md', 500), hit('b.md', 500), hit('c.md', 500)];
    const { lines } = assemble(hits, { budget: 120 });
    ok(lines.join('\n').length <= 120, `极小预算 120 也不撑破（实得 ${lines.join('\n').length}）`);
    ok(lines.every((l) => l.startsWith('【')), '被跳过的条目不会留下"半截标题"');
  }

  // ⑥ head 已经占掉的预算要被扣掉（hook 里全局偏好段就是这么传进来的）
  {
    const head = ['【全局偏好】\n' + '乙'.repeat(400)];
    const hits = [hit('a.md', 800), hit('b.md', 800)];
    const { lines } = assemble(hits, { budget: 700, head, used: 400 });
    ok(lines.join('\n').length <= 700, `head 占 400 后仍守 700 上限（实得 ${lines.join('\n').length}）`);
    ok(lines[0].startsWith('【全局偏好】'), 'head 段保持在最前，不被降级产物挤掉');
  }
}
