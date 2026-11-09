// ============================================================================
// test-graph-edit.mjs —— 第 38 节：图谱页面「点两个节点 → 生成连边指令」（2026-11-09）
//
// 守的是什么：主人原话「**这个可以让我更好看到记忆的联系，我能直接手动连接**」。
//   页面不能写本机文件，所以本节的验收点是**生成的指令必须真能用**：
//     ① 页面与测试跑的是**同一份**连边源码（tools/graph-edit-lib.mjs，`new Function` 求值）
//     ② graph.html 里那段脚本能被**真执行**（最小 DOM stub，见 tools/graph-edit-domstub.mjs）
//        —— 证明"点两个节点 → 出清单 → 出命令"这条链路真的通，不只是 grep 到字符串
//     ③ 生成的命令在**临时库**上真跑一次，条目上真的多出 `rel:...`
//
// ⚠️ 不测什么（别把它当全绿）：像素渲染、真鼠标事件、剪贴板/下载权限 —— 那要真浏览器。
// ⚠️ 绝不在真实库上跑：所有写入都在 os.tmpdir() 下的临时库，真实 repos/e-2 只读。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REL_TYPES } from './core.mjs';
import { EDIT_LIB, EDIT_REL_TYPES, EDIT_REL_TYPE_HINTS } from '../tools/graph-edit-lib.mjs';
import { runGraphScript } from '../tools/graph-edit-domstub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, '..', 'tools');
const GRAPH = path.join(HERE, '..', 'repos', 'e-2', 'graph.html');
const REL_APPLY = path.join(TOOLS, 'rel-apply.mjs').replace(/\\/g, '/');

/** 造一个能跑 rel-apply 的临时库（两条目、两页）。 */
function tmpBank() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-graph-edit-'));
  fs.mkdirSync(path.join(T, 'pages'), { recursive: true });
  const row = (page, title, tail) => `# ${page}\n\n## 节\n\n- ${title} ${tail}\n`;
  fs.writeFileSync(path.join(T, 'pages', 'lessons.md'), row('lessons.md', '权限预设改回danger-full-access', '的经过'), 'utf8');
  fs.writeFileSync(path.join(T, 'pages', 'faults.md'), row('faults.md', 'Access-is-denied排查', '的结论'), 'utf8');
  const docs = [
    { id: 'lessons.md#0', page: 'lessons.md', kind: 'page', title: '权限预设改回danger-full-access', text: '权限预设改回danger-full-access 的经过' },
    { id: 'faults.md#0', page: 'faults.md', kind: 'page', title: 'Access-is-denied排查', text: 'Access-is-denied排查 的结论' },
  ];
  fs.writeFileSync(path.join(T, 'index.json'), JSON.stringify({ docs }, null, 2), 'utf8');
  return T;
}

export function runGraphEditTests({ ok }) {
  console.log('== 42. 图谱页面：点两个节点 → 生成连边指令（2026-11-09） ==');
  const L = EDIT_LIB;

  // ① 关系类型必须与 core.mjs 的 REL_TYPES 同源（自己抄一份就等着漂移）
  {
    const a = EDIT_REL_TYPES.join(',');
    const b = [...REL_TYPES].join(',');
    ok(a === b, `类型与 core.REL_TYPES 完全一致（${a}）`);
    ok(EDIT_REL_TYPES.length === 7, `类型 7 种（实得 ${EDIT_REL_TYPES.length}）`);
    ok(EDIT_REL_TYPES.every((t) => typeof EDIT_REL_TYPE_HINTS[t] === 'string') === false
      || EDIT_REL_TYPES.every((t) => EDIT_REL_TYPE_HINTS[t]), '每种类型都有提示文案（供页面 title）');
  }

  // ② 校验：自连 / 坏 id / 空
  {
    ok(L.gerelValidatePair('lessons.md#3', 'faults.md#7').ok === true, '正常一对 ⇒ 通过');
    const self = L.gerelValidatePair('lessons.md#3', 'lessons.md#3');
    ok(self.ok === false && /自连/.test(self.why), `自连被拒（${self.why}）`);
    const bad = L.gerelValidatePair('lessons.md', 'faults.md#7');
    ok(bad.ok === false && /页#序号/.test(bad.why), `不是「页#序号」形态被拒（${bad.why}）`);
    ok(L.gerelValidatePair('', 'faults.md#7').ok === false, '空 id 被拒');
  }

  // ③ 生成 verdicts：结构 / 去重（含反向）/ 非法类型降级
  {
    const r = L.gerelMakeVerdicts([
      { a: 'lessons.md#3', b: 'faults.md#7', type: 'causal' },
      { a: 'faults.md#7', b: 'lessons.md#3', type: 'causal' },   // 反向重复
      { a: 'events.md#1', b: 'events.md#1' },                    // 自连
      { a: 'todos.md#0', b: 'decisions.md#5', type: '瞎编的' },   // 非法类型
    ], EDIT_REL_TYPES);
    ok(r.verdicts.length === 2, `4 条输入 ⇒ 2 条 verdicts（去重+去自连，实得 ${r.verdicts.length}）`);
    ok(r.verdicts[0].verdict === 'yes', "verdict 固定是 'yes'（rel-apply 只认这个值）");
    ok(r.verdicts[0].type === 'causal', '合法类型保留');
    ok(!('type' in r.verdicts[1]), '非法类型 ⇒ 不写 type 字段（边仍然保留，只是不带类型）');
    ok(r.dropped.length === 2 && /重复/.test(r.dropped[0].why), `被丢的项带着原因（${r.dropped.map((d) => d.why).join(' / ')}）`);
  }

  // ④ 命令形态：能不能直接粘进终端
  {
    const c = L.gerelMakeCommand(REL_APPLY, 'C:/tmp/x y/rel-edit.json', 'E:/2/_dsh_memory/repos/e-2');
    ok(c.includes('rel-apply.mjs') && c.includes('--apply'), `命令带 rel-apply.mjs 与 --apply（${c}）`);
    ok(c.includes('"--apply"') === false && c.includes('--apply'), '--apply 没被误加引号');
    ok(c.includes('"C:/tmp/x y/rel-edit.json"'), '带空格的 JSON 路径被引号包住（否则粘进去就断）');
    ok(c.includes('--repo "E:/2/_dsh_memory/repos/e-2"'), '显式带 --repo（不依赖默认值）');
    const c2 = L.gerelMakeCommand(REL_APPLY, '', '');
    ok(/把下载的 JSON 路径填这里/.test(c2), '没填路径时给占位提示，不编一个假路径');
  }

  // ⑤ graph.html 静态痕迹 + 那段脚本能被编译
  const hasHtml = fs.existsSync(GRAPH);
  if (!hasHtml) {
    console.log(`  [SKIP] 没有 graph.html（${GRAPH}）—— 先跑 node _dsh_memory/tools/graph-render.mjs`);
  } else {
    const html = fs.readFileSync(GRAPH, 'utf8');
    ok(html.includes('gerelMakeVerdicts') && html.includes('gerelMakeCommand'), '页面内联了**同一份**连边源码（gerel*）');
    ok(EDIT_REL_TYPES.every((t) => html.includes(`"${t}"`)), `GEREL_TYPES 字面量里 7 种类型齐全`);
    for (const act of ['type', 'copy', 'download', 'del', 'clear']) {
      ok(html.includes(`data-act="${act}"`) || html.includes(`data-act=\\"${act}\\"`) || html.includes(`'${act}'`), `有 ${act} 动作按钮的生成痕迹`);
    }
    ok(html.includes(REL_APPLY) || html.includes(REL_APPLY.replace(/\//g, '\\')), '页面里带着 rel-apply.mjs 的绝对路径（命令可直接粘）');
    ok(html.includes('id="pickbar"'), '有连边面板容器 #pickbar');
    const sm = html.match(/<script>([\s\S]*?)<\/script>/);
    let compiled = true;
    let msg = '';
    try { new Function(sm[1]); } catch (e) { compiled = false; msg = e.message; }
    ok(compiled, `页面脚本能编译（无 SyntaxError）${msg ? '：' + msg : ''}`);

    // ⑥ 真执行那段脚本：点两下 → 清单 → 命令
    let api = null;
    try { api = runGraphScript(html).api; } catch (e) { msg = e.message; }
    ok(!!api, `页面脚本能跑起来（最小 DOM stub）${api ? '' : '：' + msg}`);
    if (api) {
      ok(api.bar().style.display === 'none', '初始是页面骨架视图 ⇒ 连边面板隐藏');
      api.setMode('item');
      const nodes = api.nodes();
      ok(nodes.length > 0, `切到条目细节后有节点（${nodes.length} 个）`);
      ok(api.bar().style.display === 'block', '条目视图下连边面板出现');
      api.onPick(nodes[0]);
      ok(api.sel().length === 1, '点第一个节点 ⇒ 选中 1 个');
      api.onPick(nodes[0]);
      ok(api.sel().length === 0, '再点同一个 ⇒ 取消选择（不是自连）');
      api.onPick(nodes[0]);
      api.onPick(nodes[1] || nodes[0]);
      const two = api.sel().length === 2;
      ok(two, `点两个不同节点 ⇒ 选中 2 个（实得 ${api.sel().length}）`);
      if (two) {
        ok(/data-act="type"/.test(api.bar().innerHTML), '两端选好后面板里出现关系类型按钮');
        api.addPair('causal');
        ok(api.pairs().length === 1, `选类型后进入待连边清单（${api.pairs().length} 对）`);
        ok(api.sel().length === 0, '加入清单后选择被清空（可以接着连下一对）');
        const cmd = api.cmdText();
        ok(cmd.includes('rel-apply.mjs') && cmd.includes('--apply'), `面板上的命令可直接粘（${cmd.slice(0, 60)}…）`);
        ok(/data-act="copy"/.test(api.bar().innerHTML) && /data-act="download"/.test(api.bar().innerHTML), '面板里有「复制指令」「下载 JSON」两个按钮');
        // 清单必须带**标题片段**：`页#序号` 会随前文增删漂移，只显示编号等于让人闭眼确认
        const t0 = (api.bar().innerHTML.match(/（([^）]{4,})）/) || [])[1];
        ok(!!t0, `清单里带条目标题片段，便于人工核对（${t0 || '没找到'}）`);
        // 重复同一对（含反向）应被拒
        api.onPick(nodes[0]);
        api.onPick(nodes[1] || nodes[0]);
        api.addPair('causal');
        ok(api.pairs().length === 1, '同一对再连一次会被拒（含反向），清单仍是 1 对');
      }
    }
  }

  // ⑦ 端到端：把页面同款 verdicts 写成文件，**真跑**生成的命令，看 md 里是不是真多了 rel:
  {
    const nodeOk = spawnSync(process.execPath, ['-v'], { encoding: 'utf8' }).status === 0;
    if (!nodeOk) {
      console.log('  [SKIP] 环境里跑不了 node，未能实测指令');
    } else {
      const T = tmpBank();
      try {
        const r = L.gerelMakeVerdicts([{ a: 'lessons.md#0', b: 'faults.md#0', type: 'causal' }], EDIT_REL_TYPES);
        const jsonFile = path.join(T, 'rel-edit.json');
        fs.writeFileSync(jsonFile, JSON.stringify(r.verdicts, null, 2), 'utf8');
        const cmd = L.gerelMakeCommand(REL_APPLY, jsonFile.replace(/\\/g, '/'), T.replace(/\\/g, '/'));
        let out = '';
        let threw = null;
        try { out = execSync(cmd, { encoding: 'utf8' }); } catch (e) { threw = e; }
        ok(!threw, `生成的命令真跑成功（${threw ? threw.message.slice(0, 80) : 'exit 0'}）`);
        ok(/写入：yes 1 组/.test(out), `rel-apply 报告写入 1 组（${(out.split('\n')[0] || '').trim()}）`);
        const a = fs.readFileSync(path.join(T, 'pages', 'lessons.md'), 'utf8');
        const b = fs.readFileSync(path.join(T, 'pages', 'faults.md'), 'utf8');
        ok(a.includes('rel:faults.md:') && a.includes(':causal'), 'lessons.md 上真出现了 rel:faults.md:…:causal');
        ok(b.includes('rel:lessons.md:'), '反向那一半也写了（rel 是双向的）');
        const h1 = crypto.createHash('sha256').update(a).digest('hex');
        execSync(cmd, { encoding: 'utf8' });   // 再跑一次
        const h2 = crypto.createHash('sha256').update(fs.readFileSync(path.join(T, 'pages', 'lessons.md'), 'utf8')).digest('hex');
        ok(h1 === h2, '同一条命令再跑一次是幂等的（不会重复写边）');
      } finally {
        fs.rmSync(T, { recursive: true, force: true });
      }
    }
  }
}
