// ============================================================================
// Memory Bank · neg-inbox —— 纠错自动进箱（2026-11-07，从 reflect 拆出）
//   借 dsh-tacit 的「零点击候选」思路：scanNegFeedback 检出的纠正原话
//   自动追加进 pages/inbox.md（带 [lessons] 标签），晋升仍由助手审箱时人工判断。
//   三道护栏：① 指纹与箱内现有条目比对；② discarded.json 已丢弃的不进；
//            ③ 单次上限 3 条（防「不对/错了」在闲聊里连中灌爆箱子）。
//   ⚠️ 本文件不许 import bank.mjs（循环依赖）；依赖 core / index 同层模块。
// ============================================================================
import { clip, day, fingerprint, readText, writeText } from './core.mjs';
import { reindexPage } from './index.mjs';
import fs from 'node:path';
import fs2 from 'node:fs';

const INBOX_HEAD = '# inbox（自动记录的待整理素材）\n\n> `ingest` 按启发式抓到的候选，**未经验证**；由助手在会话里判断后移入对应知识页，然后从这里删掉。\n';
const MAX_PER_RUN = 3;

/** 读 discarded.json 的指纹集合（与 ingest 同款归一化口径）。 */
function discardedSet(dir) {
  try {
    return new Set((JSON.parse(fs2.readFileSync(fs.join(dir, 'discarded.json'), 'utf8')).items || []).map((s) => String(s)));
  } catch { return new Set(); }
}

/** negCandidates 去重后追加进 pages/inbox.md，返回实际进箱条数。 */
export function pushNegToInbox(dir, list = []) {
  if (!Array.isArray(list) || !list.length) return 0;
  const pf = fs.join(dir, 'pages', 'inbox.md');
  let prev = readText(pf) || INBOX_HEAD;
  const gone = discardedSet(dir);
  let added = 0;
  for (const raw of list) {
    if (added >= MAX_PER_RUN) break;
    const t = clip(String(raw), 200);
    if (prev.includes(t.slice(0, 50))) continue;        // 箱内已有同文
    if (gone.has(fingerprint(t))) continue;             // 曾被丢弃
    writeText(pf, `${prev.replace(/\s+$/, '')}\n\n- ${day()} [lessons] ${t}\n`);
    prev = readText(pf);
    added++;
  }
  if (added) { try { reindexPage(dir, 'inbox.md'); } catch { /* 索引失败不拖垮反思 */ } }
  return added;
}
