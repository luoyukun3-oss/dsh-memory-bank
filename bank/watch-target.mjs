// ============================================================================
// Memory Bank · watch-target —— 按目标类型取回「最新评论」快照（2026-10-04 新增）
//
// 起因：#7123 / #8634 / #8797 / #8798 全是 **discussion**，而 `cli watch check`
// 原先只走 `gh issue view` ⇒ 这类目标一律「查询失败」，等于盯不了自己发的帖。
// 分工：本模块只做「取回 + 归一到 applyIssue 认识的形状」，不碰状态文件（那是 watch.mjs）。
// 判据：issue 优先（老行为不变）；issue 拿不到时，当 discussion 再查一次。
// ============================================================================
import { spawnSync } from 'node:child_process';

const DQ = 'query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){discussion(number:$i){number closed comments(first:100){nodes{author{login} createdAt body replies(first:100){nodes{author{login} createdAt body}}}}}}}';

/** 归一成 applyIssue 要的形状：{ number, state, comments }（comments 已把 replies 展平）。
 *  ⚠️ 展平顺序必须稳定（顶层评论后紧跟它的 replies）—— applyIssue 用 slice(prev) 取新增。 */
export function fetchWatchTarget(repo, number, gh = 'gh') {
  const r = spawnSync(gh, ['issue', 'view', String(number), '--repo', repo, '--json', 'number,state,comments'], { encoding: 'utf8', env: process.env });
  if (r.status === 0) {
    try { return { ok: true, v: JSON.parse(r.stdout) }; } catch (e) { return { ok: false, why: e.message }; }
  }
  const [owner, name] = String(repo).split('/');
  const rd = spawnSync(gh, ['api', 'graphql', '-f', `query=${DQ}`, '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `i=${number}`], { encoding: 'utf8', env: process.env });
  if (rd.status !== 0) return { ok: false, why: String(rd.stderr || '').trim().split('\n')[0] || 'query failed' };
  try {
    const d = JSON.parse(rd.stdout)?.data?.repository?.discussion;
    if (!d) return { ok: false, why: '既不是 issue 也不是 discussion' };
    const comments = [];
    for (const c of d.comments?.nodes || []) {
      comments.push({ author: c.author, createdAt: c.createdAt, body: c.body });
      for (const rp of c.replies?.nodes || []) comments.push({ author: rp.author, createdAt: rp.createdAt, body: rp.body });
    }
    return { ok: true, v: { number: d.number, state: d.closed ? 'CLOSED' : 'OPEN', comments } };
  } catch (e) { return { ok: false, why: e.message }; }
}
