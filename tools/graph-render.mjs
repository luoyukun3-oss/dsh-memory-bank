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

const repo = process.argv[2] || 'E:/2/_dsh_memory/repos/e-2';
const outFile = process.argv[3] || path.join(repo, 'graph.html');
const CO_MIN = Number(process.argv[4] || 80);

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
</style></head><body>
<canvas id="c"></canvas>
<div id="hud"><h1>记忆银行 · 联想图谱</h1>
  <div class="sub" id="stat"></div></div>
<div id="tabs"><button id="tPage" class="on">页面骨架</button><button id="tItem">条目细节</button></div>
<div id="panel"></div>
<div id="legend"></div>
<script>
const DATA = ${JSON.stringify(data)};
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
addEventListener('mouseup', () => { dragNode = null; panning = false; last = null; cv.classList.remove('drag'); });
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

// 图例
const lg = document.getElementById('legend');
lg.innerHTML = DATA.page.nodes.slice(0, 10).map((p) =>
  '<div><span class="dot" style="background:' + PAGE_COLORS[p.id] + '"></span>' + esc(p.id) + '</div>').join('') +
  '<div style="margin-top:6px;color:#5c6478">亮线=人工 rel 边　暗线=共现<br>滚轮缩放 · 拖拽平移/拖动节点</div>';

document.getElementById('tPage').onclick = () => setMode('page');
document.getElementById('tItem').onclick = () => setMode('item');
function setMode(m) {
  mode = m;
  document.getElementById('tPage').className = m === 'page' ? 'on' : '';
  document.getElementById('tItem').className = m === 'item' ? 'on' : '';
  cam = { x: 0, y: 0, k: 1 };
  build();
}

build();
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
