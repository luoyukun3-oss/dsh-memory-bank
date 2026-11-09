// ============================================================================
// Memory Bank · extract-config —— LLM 配置定位（2026-11-09 从 extract.mjs 按域拆出）
//
// 为什么拆：加「游标 + 分批」后 extract.mjs 涨到 404/360 超限。按项目原则
//   「只许瘦不许胖，超限先按域拆」（先例：commands/tick-log.mjs、commands/tick-maintain.mjs）。
//   这里只装「配置从哪来」这件事：解析 patch 的 provider 块 + 从 credentials/env 取 key。
//
// 配置来源（**只读**，不落盘、不打印 key）：
//   · key   ← `$<apiKeyEnv>`（patch 里写明的变量名，实测是 SHENGYAN_API_KEY）或 `$DSH_HOME/.credentials.yaml` 的 `refs:` 段
//   · base  ← `$SHENGYAN_BASE_URL` 或 profile 的 `cordis.patch.yml` 里该 provider 的 `baseURL:`
//   · model ← `$EXTRACT_MODEL` 或 patch 里该 provider 的第一个 `- id:`
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const unquote = (s) => String(s || '').replace(/^["']|["']$/g, '').trim();

/** 用正则从 YAML 里抠三个值（不做完整解析 —— 只认 DSH 自己的这两种写法，抠不到就返回空）
 *  ⚠️ patch 里可能有**多个** provider（各家都有自己的 baseURL）⇒ 必须先按 `apiKeyEnv` 定位到
 *     目标那一家，再在它后面找 baseURL / model。不做这一步就会抓到别家的地址（写这条时栽过）。 */
export function parseProviderConfig(yamlText, { preferKeyEnv = 'SHENGYAN_API_KEY' } = {}) {
  const lines = String(yamlText || '').split(/\r?\n/);
  let keyEnv = '';
  let baseUrl = '';
  let model = '';
  const hit = (re) => lines.findIndex((l) => re.test(l));
  // ① 先找优先的那一家；找不到才退回到"第一个 apiKeyEnv"
  let at = hit(new RegExp('^\\s*apiKeyEnv:\\s*' + preferKeyEnv + '\\s*$'));
  if (at === -1) at = hit(/^\s*apiKeyEnv:\s*\S/);
  if (at !== -1) keyEnv = unquote(lines[at].replace(/^\s*apiKeyEnv:\s*/, ''));
  let from = at === -1 ? 0 : at;   // 只在该 provider 的块内往后找
  for (let i = from; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*baseURL:\s*(\S+)/);
    if (m) { baseUrl = unquote(m[1]); from = i; break; }
  }
  for (let i = from; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*-\s*id:\s*(\S+)/);
    if (m) { model = unquote(m[1]); break; }
  }
  return { keyEnv, baseUrl, model };
}

/**
 * 找 LLM 配置。**只返回位置与值，不打印 key**；找不到就给 `ok:false` + 原因。
 * @param {{env?:object, files?:{credentials?:string, patch?:string}}} opts 测试可注入
 */
export function loadLlmConfig({ env = process.env, files = {} } = {}) {
  const home = str(env.DSH_HOME) || path.join(os.homedir(), '.dsh');
  const profileDir = str(env.DSH_PROFILE_DIR) || path.join(home, 'profiles', 'desktop');
  const credFile = files.credentials || path.join(home, '.credentials.yaml');
  const patchFile = files.patch || path.join(profileDir, 'cordis.patch.yml');
  const prov = (() => {
    try { return parseProviderConfig(fs.readFileSync(patchFile, 'utf8')); } catch { return { keyEnv: '', baseUrl: '', model: '' }; }
  })();
  const keyEnvName = prov.keyEnv || 'SHENGYAN_API_KEY';
  // key：环境变量优先，其次 credentials 的 refs 段（DSH 把 refs 注入给 provider）
  let apiKey = str(env[keyEnvName]);
  let keyFrom = apiKey ? 'env.' + keyEnvName : '';
  if (!apiKey) {
    try {
      const m = fs.readFileSync(credFile, 'utf8').match(new RegExp('^\\s*' + keyEnvName + ':\\s*(\\S+)\\s*$', 'm'));
      if (m) { apiKey = unquote(m[1]); keyFrom = path.basename(credFile) + ':refs.' + keyEnvName; }
    } catch { /* 没有这个文件就当没 key */ }
  }
  const baseUrl = unquote(str(env.SHENGYAN_BASE_URL)) || prov.baseUrl;
  const model = unquote(str(env.EXTRACT_MODEL)) || prov.model;
  if (!apiKey) return { ok: false, reason: 'no-api-key（没找到 ' + keyEnvName + '）', keyFrom, baseUrl, model };
  if (!baseUrl) return { ok: false, reason: 'no-base-url（patch 里没抠到 baseURL）', keyFrom, baseUrl, model };
  if (!model) return { ok: false, reason: 'no-model', keyFrom, baseUrl, model };
  return { ok: true, apiKey, keyFrom, baseUrl, model, baseFrom: str(env.SHENGYAN_BASE_URL) ? 'env' : 'patch' };
}
