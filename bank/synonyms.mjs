/**
 * 烘焙同义词（2026-11-02）：`<repo>/synonyms.json`，由 `tools/syn-bake.mjs` 用 LLM 从
 * `cue.json` 的术语批量生成「用户口语变体」。带 mtime 缓存。
 *
 * 为什么单独成文件而不是塞进 core.mjs：
 *   ① core.mjs 有**行数预算**（test.mjs 会红），加一个函数就超 6 行；
 *   ② 职责上它也不属于 core —— core 是全模块共用的底座，这份只是 search 的检索扩展源。
 *
 * ⚠️ **为什么不并进 `aliases.md`**（实测踩过，别合并回去）：
 *   ① `reflect` 拿 `loadAliases()` 的**首列**当反思主题 —— 烘焙组里有「记忆系统」，
 *      含子串「忆系」，会撞 test.mjs 的 `/有什|是什|请输|忆系|析一/` 碎片断言；
 *   ② `rel:` 边的 key 校验按**页内条目**找，烘焙组「数字输入容错」与原组构成子串级 2 命中。
 *   ⇒ 烘焙产物**只给 search() 做检索扩展**，不参与主题提取、不进 rel 目标池。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readText } from './core.mjs';

const synonymCache = new Map();

export function loadSynonyms(dir) {
  const f = path.join(dir, 'synonyms.json');
  let mt = 0;
  try { mt = fs.statSync(f).mtimeMs; } catch { return []; }
  const hit = synonymCache.get(dir);
  if (hit && hit.mt === mt) return hit.groups;
  let groups = [];
  try {
    const j = JSON.parse(readText(f));
    groups = (j.groups || []).filter((g) => Array.isArray(g) && g.length >= 2);
  } catch { groups = []; }
  synonymCache.set(dir, { mt, groups });
  return groups;
}
