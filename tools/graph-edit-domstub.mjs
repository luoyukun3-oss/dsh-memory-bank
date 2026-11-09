// ============================================================================
// graph-edit-domstub —— 在 Node 里**真执行** graph.html 那段页面脚本的最小 DOM 环境（2026-11-09）
//
// 为什么要它：graph.html 是静态产物，"grep 到 data-act=\"type\"" 只证明**字符串在文件里**，
//   证明不了**点两下真能出清单和命令**。没有 jsdom 也不想引依赖 ⇒ 这里手搓一个够用的 stub，
//   把页面的 `<script>` 原样 `new Function` 跑起来，再把内部状态暴露出来断言。
//
// ⚠️ 边界（别夸大）：stub 是 **no-op 画布 + 假元素**，它验证的是
//   「脚本能跑通、选点→清单→命令这条链路的状态转换正确、没有 ReferenceError/TDZ」，
//   **不验证**像素渲染、真实鼠标事件、剪贴板/下载权限 —— 那需要真浏览器/Playwright。
//   报告里按"验证到哪一步"如实写。
//
// 为什么允许注入导出（`pickbar` 等）：`new Function` 后函数内部变量不可见，所以测试在源码
//   末尾追加一行 `return {…}` 把内部句柄交出来。**被执行的仍是页面那段源码本身**（追加前
//   逐字比对过长度），不是复制出来的一份。
// ============================================================================

/** 造一个"能被页面脚本接受"的最小 document。 */
function makeElement(id) {
  const el = {
    id,
    tagName: id === 'c' ? 'CANVAS' : 'DIV',
    style: {},
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    children: [],
    onclick: null,
    width: 1400,
    height: 900,
    listeners: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener() {},
    getAttribute(k) { return el.attrs && el.attrs[k] != null ? el.attrs[k] : null; },
    setAttribute(k, v) { if (!el.attrs) el.attrs = {}; el.attrs[k] = v; },
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    select() {},
    click() { el.clicked = (el.clicked || 0) + 1; },
    attrs: {},
  };
  if (id === 'c') {
    // canvas 2d 上下文：所有方法 no-op，所有属性可写（页面只用绘图 API，不读回）
    const ctx = new Proxy({}, {
      get(t, k) { return k in t ? t[k] : () => {}; },
      set(t, k, v) { t[k] = v; return true; },
    });
    el.getContext = () => ctx;
  }
  return el;
}

/**
 * 跑 graph.html 里的页面脚本。
 * @param {string} html graph.html 全文
 * @returns {{api:object, dom:object}} api 是脚本末尾被导出的内部句柄
 */
export function runGraphScript(html) {
  const m = String(html).match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('graph.html 里没找到 <script> 块');
  const src = m[1];
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeElement(id));
      return els.get(id);
    },
    createElement(tag) { const e = makeElement('created-' + tag); e.tagName = String(tag).toUpperCase(); return e; },
    body: { appendChild() {}, removeChild() {} },
  };
  const windowListeners = {};
  const globalAddEventListener = (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); };
  let raf = 0;
  const requestAnimationFrame = (cb) => { if (raf++ < 1) cb(); };   // 只跑两帧，避免死循环
  const navigator = { clipboard: null };
  const URL = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };
  class Blob { constructor(parts) { this.parts = parts; } }
  const timers = [];
  const setTimeoutStub = (fn) => { timers.push(fn); return timers.length; };

  // 末尾追加一行导出：交出内部句柄（被执行的仍是上面那段源码本身）
  const tail = '\n;return { setMode: setMode, onPick: onPick, addPair: addPair, renderBar: renderBar,'
    + ' cmdText: cmdText, downloadJson: downloadJson,'
    + ' nodes: function () { return nodes; }, pairs: function () { return pairs; },'
    + ' sel: function () { return sel; }, mode: function () { return mode; },'
    + ' bar: function () { return document.getElementById("pickbar"); } };';
  const fn = new Function(
    'document', 'addEventListener', 'requestAnimationFrame', 'devicePixelRatio',
    'innerWidth', 'innerHeight', 'navigator', 'Blob', 'URL', 'setTimeout',
    src + tail,
  );
  const api = fn(document, globalAddEventListener, requestAnimationFrame, 1, 1400, 900, navigator, Blob, URL, setTimeoutStub);
  return { api, dom: { elements: els, windowListeners, timers } };
}
