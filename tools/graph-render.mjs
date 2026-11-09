#!/usr/bin/env node
// ============================================================================
// graph-render —— 把记忆银行的「联想结构」渲染成一张可交互的力导向图
//
//   node _dsh_memory/tools/graph-render.mjs [repo目录] [输出html] [共现阈值]
//
// 数据源（全部只读）：
//   index.json   条目（id = 页#序号）+ meta.rel（人工边）
//   cooccur.json 共现（同一轮被一起命中过 N 次 ⇒ 行为证据）
//
// 两种视图（HTML 里切换）：
//   ① 页面骨架：页 = 节点，页间连线权重 = 跨页共现之和 + 跨页 rel 数
//   ② 条目细节：条目 = 节点（按页着色），边 = rel（亮）+ 共现≥阈值（暗）
//
// 刻意不引 CDN：所有 JS 内联，离线可开。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 连边指令的**唯一实现**（2026-11-09）：这套源码既内联进页面，也被 bank/test-graph-edit.mjs
// 用 new Function 求值做断言 —— 一份实现两处执行，避免"页面一份、测试一份"的漂移。
import { EDIT_LIB_SRC, EDIT_REL_TYPES, EDIT_REL_TYPE_HINTS } from './graph-edit-lib.mjs';

const repo = process.argv[2] || 'E:/2/_dsh_memory/repos/e-2';
const outFile = process.argv[3] || path.join(repo, 'graph.html');
const CO_MIN = Number(process.argv[4] || 80);
// 连边命令要用的两个绝对路径（转成正斜杠：粘进 PowerShell / bash 都不用改）
const REL_APPLY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rel-apply.mjs').replace(/\\/g, '/');
const REPO_ABS = path.resolve(repo).replace(/\\/g, '/');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const idx = readJson(path.join(repo, 'index.json'));
const co = fs.existsSync(path.join(repo, 'cooccur.json')) ? readJson(path.join(repo, 'cooccur.json')) : {};

const pageOf = (id) => String(id).split('#')[0];
const short = (s, n = 48) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// —— 条目表：id -> {id, page, title, importance, tags, rel} ——
const byId = new Map();
for (const d of idx.docs) {
  const id = d.id;
  if (!id) continue;
  byId.set(id, {
    id,
    page: pageOf(id),
    title: short(d.title || d.text || '', 60),
    importance: (d.meta && d.meta.importance) || 0,
    tags: (d.meta && d.meta.tags) || [],
    rel: (d.meta && d.meta.rel) || [],
  });
}

// —— rel 边：{page,key} 是「文本片段」，要回查同页里 title/text 以它开头的条目 ——
const pageDocs = new Map();
for (const v of byId.values()) {
  if (!pageDocs.has(v.page)) pageDocs.set(v.page, []);
  pageDocs.get(v.page).push(v);
}
let relMiss = 0;
const relEdges = [];
for (const v of byId.values()) {
  for (const r of v.rel) {
    const cands = pageDocs.get(r.page) || [];
    const hit = cands.find((c) => c.title.includes(String(r.key || '').slice(0, 12)) || v.title === r.key);
    if (!hit) { relMiss += 1; continue; }
    relEdges.push({ a: v.id, b: hit.id, type: r.type || '', kind: 'rel', w: 1 });
  }
}

// —— 共现边 ——
const coEdges = [];
for (const [a, targets] of Object.entries(co)) {
  for (const [b, n] of Object.entries(targets)) {
    if (n >= CO_MIN && byId.has(a) && byId.has(b) && a < b) {
      coEdges.push({ a, b, kind: 'co', w: n });
    }
  }
}

// —— 条目图：只留有边的节点 ——
const used = new Set();
for (const e of relEdges) { used.add(e.a); used.add(e.b); }
for (const e of coEdges) { used.add(e.a); used.add(e.b); }
const itemNodes = [...used].map((id) => {
  const v = byId.get(id);
  const deg = relEdges.filter((e) => e.a === id || e.b === id).length;
  return { id: v.id, page: v.page, title: v.title, imp: v.importance, deg, tags: v.tags.slice(0, 4) };
});

// —— 页面骨架图 ——
const pageSet = [...new Set(itemNodes.map((n) => n.page))];
const pageNodes = pageSet.map((p) => ({ id: p, title: p, deg: itemNodes.filter((n) => n.page === p).length }));
const pw = new Map();
const addPw = (a, b, w) => {
  if (!a || !b || a === b) return;
  const k = a < b ? a + '\u0000' + b : b + '\u0000' + a;
  pw.set(k, (pw.get(k) || 0) + w);
};
for (const e of coEdges) addPw(pageOf(e.a), pageOf(e.b), e.w);
for (const e of relEdges) addPw(pageOf(e.a), pageOf(e.b), 6);
const pageEdges = [...pw.entries()].map(([k, w]) => {
  const [a, b] = k.split('\u0000');
  return { a, b, kind: 'page', w };
});

const data = {
  meta: {
    builtAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    repo: path.basename(repo),
    // 连边面板要用：工具绝对路径 + 仓库绝对路径（页面不能写文件，但可以生成一条能粘进终端的命令）
    toolPath: REL_APPLY,
    repoPath: REPO_ABS,
    coMin: CO_MIN,
    docs: byId.size,
    itemNodes: itemNodes.length,
    relEdges: relEdges.length,
    coEdges: coEdges.length,
    relMiss,
  },
  page: { nodes: pageNodes, edges: pageEdges },
  item: { nodes: itemNodes, edges: [...relEdges, ...coEdges] },
};

const html = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆银行 · 联想图谱</title>
<style>
  :root{--bg:#0b0d12;--fg:#e8eaf0;--dim:#8a90a6;--line:#1d2230}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);
    font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}
  canvas{display:block;cursor:grab}
  canvas.drag{cursor:grabbing}
  #hud{position:fixed;left:16px;top:14px;pointer-events:none;user-select:none}
  #hud h1{margin:0 0 4px;font-size:15px;font-weight:600;letter-spacing:.04em}
  #hud .sub{color:var(--dim);font-size:12px}
  #tabs{position:fixed;left:16px;top:74px;display:flex;gap:6px}
  #tabs button{background:#151a24;color:var(--dim);border:1px solid var(--line);border-radius:6px;
    padding:5px 12px;font-size:12px;cursor:pointer}
  #tabs button.on{background:#1d2637;color:var(--fg);border-color:#2d3b55}
  #panel{position:fixed;right:16px;top:14px;width:320px;max-height:78vh;overflow:auto;
    background:#11151dcc;border:1px solid var(--line);border-radius:10px;padding:14px;
    backdrop-filter:blur(8px);font-size:12px;display:none}
  #panel h2{margin:0 0 8px;font-size:13px;font-weight:600}
  #panel .kv{color:var(--dim);margin:2px 0}
  #panel .tag{display:inline-block;background:#1c2536;color:#9fb4d8;border-radius:4px;
    padding:1px 6px;margin:2px 3px 0 0;font-size:11px}
  #legend{position:fixed;left:16px;bottom:14px;color:var(--dim);font-size:11px;line-height:1.7}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
  /* —— 连边面板（2026-11-09）：点两个节点 → 选类型 → 生成可粘贴的指令 —— */
  #pickbar{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:9;display:none;
    background:#11151df2;border:1px solid #2d3b55;border-radius:10px;padding:10px 14px;
    font-size:12px;min-width:min(680px,92vw);max-width:92vw;backdrop-filter:blur(8px)}
  #pickbar .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  #pickbar .row .lbl{color:var(--dim)}
  #pickbar button{background:#151a24;color:#cfd6e6;border:1px solid var(--line);border-radius:6px;
    padding:4px 10px;font-size:12px;cursor:pointer}
  #pickbar button:hover{background:#1d2637}
  #pickbar button.on{background:#243b2b;border-color:#3f7a52;color:#b8f0c8}
  #pickbar button.warn{color:#f0c674;border-color:#5a4a25}
  #pairlist{margin-top:8px;max-height:24vh;overflow:auto}
  #pairlist .p{display:flex;justify-content:space-between;gap:10px;padding:2px 0;color:#cfd6e6}
  #pairlist .p .k{color:#8a90a6}
  #pairlist .p button{padding:1px 7px;font-size:11px}
  #cmdbox{width:100%;margin-top:6px;background:#0b0d12;color:#9fe0b0;border:1px solid var(--line);
    border-radius:6px;padding:6px 8px;font:11px/1.5 Consolas,monospace;resize:vertical}
  #pickbar .hint{color:#f0c674;margin-top:6px}
  #pickbar .dim{color:var(--dim);margin-top:6px}
</style></head><body>
<canvas id="c"></canvas>
<div id="hud"><h1>记忆银行 · 联想图谱</h1>
  <div class="sub" id="stat"></div></div>
<div id="tabs"><button id="tPage" class="on">页面骨架</button><button id="tItem">条目细节</button></div>
<div id="panel"></div>
<div id="pickbar"></div>
<div id="legend"></div>
<script>
${EDIT_LIB_SRC}
const DATA = ${JSON.stringify(data)};
const GEREL_TYPES = ${JSON.stringify(EDIT_REL_TYPES)};
const GEREL_HINTS = ${JSON.stringify(EDIT_REL_TYPE_HINTS)};
const PAGE_COLORS = {};
const PALETTE = ['#6ea8fe','#f7a1c4','#7ee0b8','#f0c674','#b39ddb','#8fd3f4','#e6a0a0','#a5d6a7','#ffb74d','#90caf9'];
let pi = 0;
for (const p of DATA.page.nodes) PAGE_COLORS[p.id] = PALETTE[pi++ % PALETTE.length];

const cv = document.getElementById('c'), ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = Math.min(devicePixelRatio || 1, 2);
function resize() {
  W = innerWidth; H = innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener('resize', resize); resize();

// —— 视图状态 ——
let mode = 'page';            // 'page' | 'item'
let nodes = [], edges = [];
let cam = { x: 0, y: 0, k: 1 };
let hover = null, dragNode = null, panning = false, last = null, alpha = 1;
// 连边用：已选中的节点（最多 2）、按下时的节点与坐标（用来区分"点击"与"拖动"）
let sel = [], downNode = null, downPt = null;

function build() {
  const src = DATA[mode];
  const N = src.nodes.map((n) => ({
    ...n,
    x: W / 2 + (Math.random() - 0.5) * Math.min(W, 900),
    y: H / 2 + (Math.random() - 0.5) * Math.min(H, 750),
    vx: 0, vy: 0,
    r: mode === 'page' ? Math.max(10, Math.sqrt(n.deg) * 7) : Math.max(3.5, Math.min(9, 3 + Math.sqrt(n.deg) * 2)),
  }));
  const map = new Map(N.map((n) => [n.id, n]));
  const E = src.edges.filter((e) => map.has(e.a) && map.has(e.b)).map((e) => ({ ...e, A: map.get(e.a), B: map.get(e.b) }));
  nodes = N; edges = E; alpha = 1;
  document.getElementById('stat').textContent =
    mode === 'page'
      ? \`\${N.length} 页 · \${E.length} 条页间连线 · 共现阈值 \${DATA.meta.coMin}\`
      : \`\${N.length} 条目 · \${E.length} 条边（rel \${DATA.meta.relEdges} / 共现 \${DATA.meta.coEdges}）\`;
}

// —— 力导向：网格加速的斥力 + 弹簧 ——
let cells = new Map(), CELL = 90;
function hash(x, y) { return ((x / CELL) | 0) + ',' + ((y / CELL) | 0); }
function fillGrid() {
  cells.clear();
  for (const n of nodes) {
    const k = hash(n.x, n.y);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(n);
  }
}
function tick() {
  fillGrid();
  const REP = mode === 'page' ? 9000 : 1600;
  for (const n of nodes) {
    n.fx = 0; n.fy = 0;
  }
  // 斥力：只算邻近 3x3 格
  for (const n of nodes) {
    const cx = (n.x / CELL) | 0, cy = (n.y / CELL) | 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = cells.get((cx + dx) + ',' + (cy + dy));
      if (!arr) continue;
      for (const m of arr) {
        if (m === n) continue;
        let ax = n.x - m.x, ay = n.y - m.y;
        let d2 = ax * ax + ay * ay;
        if (d2 < 1) { ax = Math.random() - 0.5; ay = Math.random() - 0.5; d2 = 1; }
        const f = REP / d2;
        n.fx += (ax / Math.sqrt(d2)) * f;
        n.fy += (ay / Math.sqrt(d2)) * f;
      }
    }
  }
  // 弹簧
  const LEN = mode === 'page' ? 170 : 95;
  for (const e of edges) {
    const w = e.kind === 'rel' ? 1.6 : Math.min(2.2, 0.6 + Math.log10(e.w + 1) * 0.5);
    let dx = e.B.x - e.A.x, dy = e.B.y - e.A.y;
    const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
    const f = ((d - LEN) / d) * 0.02 * w;
    e.A.fx += dx * f; e.A.fy += dy * f;
    e.B.fx -= dx * f; e.B.fy -= dy * f;
  }
  // 向心 + 阻尼
  for (const n of nodes) {
    n.fx += (W / 2 - n.x) * 0.002;
    n.fy += (H / 2 - n.y) * 0.002;
    n.vx = (n.vx + n.fx * alpha) * 0.82;
    n.vy = (n.vy + n.fy * alpha) * 0.82;
    const cap = 14;
    n.vx = Math.max(-cap, Math.min(cap, n.vx));
    n.vy = Math.max(-cap, Math.min(cap, n.vy));
    n.x += n.vx; n.y += n.vy;
  }
  alpha *= 0.995;
  if (alpha < 0.02) alpha = 0.02;   // 保持一点微动
}

// —— 绘制 ——
function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(cam.k, cam.k); ctx.translate(-W / 2 + cam.x, -H / 2 + cam.y);

  const hi = hover;
  const near = new Set();
  if (hi) { near.add(hi.id); for (const e of edges) { if (e.A === hi) near.add(e.B.id); if (e.B === hi) near.add(e.A.id); } }

  // 边
  for (const e of edges) {
    const dim = hi && !(near.has(e.A.id) && near.has(e.B.id));
    if (e.kind === 'rel') {
      ctx.strokeStyle = dim ? '#2a3550' : 'rgba(240,198,116,.55)';
      ctx.lineWidth = dim ? 0.6 : 1.4;
    } else {
      const a = dim ? 0.05 : Math.min(0.5, 0.06 + Math.log10(e.w + 1) * 0.12);
      ctx.strokeStyle = 'rgba(120,150,200,' + a + ')';
      ctx.lineWidth = dim ? 0.4 : Math.min(2.2, 0.5 + Math.log10(e.w) * 0.55);
    }
    ctx.beginPath(); ctx.moveTo(e.A.x, e.A.y); ctx.lineTo(e.B.x, e.B.y); ctx.stroke();
  }
  // 节点
  for (const n of nodes) {
    const col = PAGE_COLORS[n.page] || '#8a90a6';
    const isHi = hi === n;
    const dim = hi && !near.has(n.id);
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r * (isHi ? 1.5 : 1), 0, Math.PI * 2);
    ctx.fillStyle = dim ? 'rgba(90,100,125,.35)' : col;
    ctx.globalAlpha = dim ? 0.4 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    // 选中环（连边第一步/第二步的视觉反馈）：见下方 onPick
    if (sel.indexOf(n) >= 0) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * (isHi ? 1.5 : 1) + 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#7ee0b8';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (mode === 'page' || isHi || (hi && near.has(n.id))) {
      ctx.fillStyle = dim ? '#3a4255' : '#dfe6f5';
      ctx.font = (mode === 'page' ? '600 12px' : '11px') + ' sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(n.title.length > 18 && mode === 'item' ? n.title.slice(0, 18) + '…' : n.title, n.x, n.y + n.r + 13);
    }
  }
  ctx.restore();
}

// —— 交互 ——
function toWorld(mx, my) {
  return { x: (mx - W / 2) / cam.k + W / 2 - cam.x, y: (my - H / 2) / cam.k + H / 2 - cam.y };
}
function pick(mx, my) {
  const p = toWorld(mx, my);
  let best = null, bd = 1e9;
  for (const n of nodes) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < n.r + 8 && d < bd) { best = n; bd = d; }
  }
  return best;
}
cv.addEventListener('mousedown', (e) => {
  const n = pick(e.clientX, e.clientY);
  downNode = n; downPt = { x: e.clientX, y: e.clientY };   // 用来区分"点击选中"与"拖动节点"
  if (n) { dragNode = n; } else { panning = true; last = { x: e.clientX, y: e.clientY }; }
  cv.classList.add('drag');
});
addEventListener('mousemove', (e) => {
  if (dragNode) {
    const p = toWorld(e.clientX, e.clientY);
    dragNode.x = p.x; dragNode.y = p.y; dragNode.vx = dragNode.vy = 0;
    return;
  }
  if (panning && last) {
    cam.x += e.clientX - last.x; cam.y += e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    return;
  }
  const n = pick(e.clientX, e.clientY);
  if (n !== hover) { hover = n; showPanel(n); }
});
addEventListener('mouseup', (e) => {
  // 「点击」判定：按下的还是同一个节点、且位移 < 5px ⇒ 这是点选，不是拖动
  if (downNode && downPt && Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) < 5) onPick(downNode);
  downNode = null; downPt = null;
  dragNode = null; panning = false; last = null; cv.classList.remove('drag');
});
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k2 = Math.max(0.25, Math.min(3.5, cam.k * (e.deltaY > 0 ? 0.92 : 1.08)));
  const mx = e.clientX, my = e.clientY;
  cam.x += (mx - W / 2) * (1 / cam.k - 1 / k2);
  cam.y += (my - H / 2) * (1 / cam.k - 1 / k2);
  cam.k = k2;
}, { passive: false });

const panel = document.getElementById('panel');
function showPanel(n) {
  if (!n) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const tags = (n.tags || []).map((t) => '<span class="tag">' + t + '</span>').join('');
  panel.innerHTML = '<h2>' + esc(n.title) + '</h2>' +
    '<div class="kv">页：' + esc(n.page) + '</div>' +
    '<div class="kv">连接度：' + n.deg + '</div>' +
    (n.imp ? '<div class="kv">importance：' + n.imp + '</div>' : '') +
    (tags ? '<div style="margin-top:6px">' + tags + '</div>' : '');
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ============================================================================
// 连边（2026-11-09）：点两个节点 → 选关系类型 → 生成「可直接粘贴运行」的建边指令
//
// 为什么是"生成指令"而不是"页面直接写进去"：浏览器**不能写本机文件**。三条路里
//   ① 本地 HTTP 服务：要常驻进程 + 端口 + 鉴权，为一次连边不值（也把"能改记忆"的能力
//      暴露成一个端口）；
//   ② 生成一行命令（本方案）：零后端、零常驻、零新写盘路径 —— 复用的是**既有**建边入口
//      tools/rel-apply.mjs（它自带：从原始 title 自动挑唯一 key、幂等、逐页备份、默认干跑）；
//   ③ 导出 JSON：本方案也保留（一个按钮），但它必然还要再手工跑一次命令 ⇒ 它是②的子集。
// ⇒ 选②，③作为同一份 JSON 的附带能力；两者用的是同一个 verdicts 结构，A 组的
//   cli rel add --from-json 将来直接吃这份文件即可。
//
// ⚠️ 校验逻辑不写在页面里：gerel* 那套源码与 bank/test-graph-edit.mjs 跑的是**同一份**
//    （见 tools/graph-edit-lib.mjs 头注释）—— 页面若另写一套，就成了两份实现各跑各的。
// ============================================================================
let pairs = [];      // 待连边清单 [{a,b,type}]
let jsonPath = '';   // 用户填的 JSON 路径（下载后填进来，命令随之更新）
let pairMsg = '';    // 上一次操作的提示（校验失败原因 / 下一步做什么）

const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// id → 条目（用来在清单里显示标题）。为什么要显示标题：「页#序号」是**索引编号**，前面增删一条
// 就整体后移（lessons 里记过这个坑：页#N 编号漂移会让边静默指到别的条目上去）。
// ⇒ 清单里带上标题，人能一眼核对"连的是不是我以为的那条"，而不是只信一个会漂的编号。
const ITEM_BY_ID = {};
for (const n of DATA.item.nodes) ITEM_BY_ID[n.id] = n;
function titleOf(id) { const n = ITEM_BY_ID[id]; return n ? n.title : ''; }
function pairCell(id) {
  const t = titleOf(id);
  return esc(id) + (t ? '<span class="k">（' + esc(t.length > 16 ? t.slice(0, 16) + '…' : t) + '）</span>' : '');
}

/** 近似判断：图里已经有一条 rel 边了？（graph-render 的边是按标题近似匹配的，非权威） */
function existingRel(a, b) {
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e.kind === 'rel' && ((e.a === a && e.b === b) || (e.a === b && e.b === a))) return true;
  }
  return false;
}
function cmdText() { return gerelMakeCommand(DATA.meta.toolPath, jsonPath, DATA.meta.repoPath); }

function onPick(n) {
  if (mode !== 'item') {
    pairMsg = '先在左上切到「条目细节」—— rel 是**条目级**的边，页节点之间不能直接连';
    renderBar();
    return;
  }
  const at = sel.indexOf(n);
  if (at >= 0) { sel.splice(at, 1); pairMsg = '已取消这个选择'; renderBar(); return; }
  if (sel.length >= 2) sel = [];
  sel.push(n);
  pairMsg = sel.length === 1 ? '已选第一个：再点第二个节点' : '两端选好了：挑一个关系类型';
  renderBar();
}

function addPair(type) {
  if (sel.length < 2) return;
  const a = sel[0].id, b = sel[1].id;
  const v = gerelValidatePair(a, b);
  if (!v.ok) { pairMsg = '加不进去：' + v.why; sel = []; renderBar(); return; }
  const k = gerelPairKey(a, b);
  for (let i = 0; i < pairs.length; i++) {
    if (gerelPairKey(pairs[i].a, pairs[i].b) === k) { pairMsg = '这一对已经在清单里了'; sel = []; renderBar(); return; }
  }
  pairs.push({ a: a, b: b, type: type || '' });
  pairMsg = '已加入清单（共 ' + pairs.length + ' 对）';
  sel = [];
  renderBar();
}

function downloadJson() {
  const r = gerelMakeVerdicts(pairs, GEREL_TYPES);
  if (!r.verdicts.length) { pairMsg = '清单是空的，没什么可导出'; renderBar(); return; }
  const blob = new Blob([JSON.stringify(r.verdicts, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rel-edit-' + Date.now() + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  pairMsg = '已下载 ' + a.download + '：把下载目录里的完整路径填进上面的输入框（我不猜你的下载目录）';
  renderBar();
}

function copyCmd() {
  const box = document.getElementById('cmdbox');
  if (!box) return;
  box.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  if (ok) { pairMsg = '命令已复制，粘到终端就能跑'; renderBar(); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(box.value).then(
      function () { pairMsg = '命令已复制，粘到终端就能跑'; renderBar(); },
      function () { pairMsg = '浏览器拒绝了剪贴板：请手动全选文本框复制（file:// 页面常被限制）'; renderBar(); },
    );
    return;
  }
  pairMsg = '复制失败：请手动全选文本框复制（file:// 页面常被限制剪贴板）';
  renderBar();
}

function renderBar() {
  const bar = document.getElementById('pickbar');
  if (mode !== 'item') { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  let h = '<div class="row"><span class="lbl">连边：</span><span>' +
    (sel.length === 0 ? '点一个节点开始' : sel.map(function (n) { return esc(n.id); }).join('  ＋  ')) +
    '</span>';
  if (sel.length) h += '<button data-act="cancel">取消选择</button>';
  if (pairs.length) h += '<button data-act="clear">清空清单</button>';
  h += '<span class="lbl">清单 ' + pairs.length + ' 对</span></div>';
  if (sel.length === 2) {
    h += '<div class="row" style="margin-top:8px"><span class="lbl">关系类型：</span>';
    for (const t of GEREL_TYPES) {
      h += '<button data-act="type" data-type="' + t + '" title="' + escAttr(GEREL_HINTS[t] || '') + '">' + t + '</button>';
    }
    h += '<button data-act="type" data-type="">不标类型</button><button data-act="cancel" class="warn">算了</button></div>';
  }
  if (pairs.length) {
    h += '<div id="pairlist">';
    pairs.forEach(function (p, i) {
      h += '<div class="p"><span>' + pairCell(p.a) + ' ↔ ' + pairCell(p.b) +
        '<span class="k"> · ' + (p.type ? esc(p.type) : '无类型') + (existingRel(p.a, p.b) ? ' · 疑似已有边' : '') + '</span></span>' +
        '<button data-act="del" data-i="' + i + '">删除</button></div>';
    });
    h += '</div>';
    h += '<div class="row" style="margin-top:8px"><span class="lbl">JSON 路径：</span>' +
      '<input id="jsonpath" placeholder="下载后把完整路径填这里" value="' + escAttr(jsonPath) + '"></div>';
    h += '<textarea id="cmdbox" readonly rows="2">' + esc(cmdText()) + '</textarea>';
    h += '<div class="row" style="margin-top:6px"><button data-act="copy">复制指令</button>' +
      '<button data-act="download">下载 JSON</button>' +
      '<span class="dim">跑完后按它打印的提示 reindex 一次，图谱才会刷新</span></div>';
  }
  if (pairMsg) h += '<div class="hint">' + esc(pairMsg) + '</div>';
  bar.innerHTML = h;
}

document.getElementById('pickbar').addEventListener('click', function (ev) {
  const t = ev.target;
  if (!t || !t.getAttribute) return;
  const act = t.getAttribute('data-act');
  if (!act) return;
  if (act === 'type') addPair(t.getAttribute('data-type') || '');
  else if (act === 'del') { pairs.splice(Number(t.getAttribute('data-i')), 1); pairMsg = '已删除一条'; renderBar(); }
  else if (act === 'clear') { pairs = []; sel = []; pairMsg = '清单已清空'; renderBar(); }
  else if (act === 'cancel') { sel = []; pairMsg = ''; renderBar(); }
  else if (act === 'copy') copyCmd();
  else if (act === 'download') downloadJson();
});
// 路径输入：只更新命令框，不整块重绘（否则输入到一半焦点就飞了）
document.getElementById('pickbar').addEventListener('input', function (ev) {
  if (ev.target && ev.target.id === 'jsonpath') {
    jsonPath = ev.target.value;
    const box = document.getElementById('cmdbox');
    if (box) box.value = cmdText();
  }
});

// 图例
const lg = document.getElementById('legend');
lg.innerHTML = DATA.page.nodes.slice(0, 10).map((p) =>
  '<div><span class="dot" style="background:' + PAGE_COLORS[p.id] + '"></span>' + esc(p.id) + '</div>').join('') +
  '<div style="margin-top:6px;color:#5c6478">亮线=人工 rel 边　暗线=共现<br>滚轮缩放 · 拖拽平移/拖动节点' +
  '<br><span style="color:#7ee0b8">连边：切到「条目细节」→ 点两个节点 → 选关系类型 → 复制指令</span></div>';

document.getElementById('tPage').onclick = () => setMode('page');
document.getElementById('tItem').onclick = () => setMode('item');
function setMode(m) {
  mode = m;
  document.getElementById('tPage').className = m === 'page' ? 'on' : '';
  document.getElementById('tItem').className = m === 'item' ? 'on' : '';
  cam = { x: 0, y: 0, k: 1 };
  sel = []; pairMsg = '';   // 换视图后旧节点对象已不在 nodes 里，选择必须清掉
  build();
  renderBar();
}

build();
renderBar();   // 初始 mode='page' ⇒ 连边面板隐藏；切到「条目细节」后出现
let frame = 0;
function loop() {
  tick();
  draw();
  frame++;
  requestAnimationFrame(loop);
}
loop();
</script>
</body></html>`;

fs.writeFileSync(outFile, html, 'utf8');
console.log('图已生成:', outFile);
console.log(`条目 ${data.meta.itemNodes} · rel 边 ${data.meta.relEdges}（未命中 ${data.meta.relMiss}）· 共现边 ${data.meta.coEdges}（阈值 ${CO_MIN}）`);
console.log(`页面骨架 ${data.page.nodes.length} 页 / ${data.page.edges.length} 连线`);
