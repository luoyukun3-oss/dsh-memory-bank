// hook 公共通道：解析 payload（stdin 或 --payload-file <path>）
// ============================================================================
// ⚠️ 为什么单独成模块（2026-09-29，按 budgets.json「超限先按域拆分」的规矩）：
//   原先 user-prompt / post-write / session-start **各写了一份 readPayload**
//   （实测在改前的第 55 / 19 / 17 行）—— 三份重复 = 「改一处、漏两处」的漂移风险
//   （同族教训：纸面约定挡不住漂移，只有单一真相源能）。
//
// ⚠️ 三份**并非完全相同**，抽取时必须保住差异（实测得来的，不是假设）：
//   user-prompt 与 session-start 用 catch (e) { warn(...) } —— 把解析失败报进 stderr，
//   因为那是 hook 唯一可用的持久通道（见 user-prompt.mjs 关于 HITS 的那段注释）；
//   而 **post-write 是静默的**（catch { return {}; }）。
//   ⇒ 故「错误怎么报」做成**可选回调**：传 warn 就报、不传就静默；绝不为了统一而改任何一方行为。
//
// 输入：stdin 的 JSON，或 --payload-file 指向的文件（带 BOM 也能吃）
// 输出：解析后的对象；**任何失败都返回 {}，绝不抛** —— 通道自己的失败不能打断主流程
import fs from 'node:fs';

/** @param {(msg: string) => void} [onError] 解析失败时的报告函数；不给则静默 */
export function readPayload(onError) {
  const i = process.argv.indexOf('--payload-file');
  const raw = i !== -1 && process.argv[i + 1]
    ? fs.readFileSync(process.argv[i + 1], 'utf8')
    : (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return '{}'; } })();
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { onError?.(`payload 解析失败：${e.message}`); return {}; }
}
