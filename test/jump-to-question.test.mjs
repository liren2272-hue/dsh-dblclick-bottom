// Regression test for the double-click scroll halves of this plugin.
//
// The plugin's client half is a browser module that calls
// window.__ModuleLoader__.load({ factory }). This harness stubs just enough of
// the DOM to load that factory, run apply(), dispatch a synthetic dblclick and
// assert the resulting scrollTop. It needs no browser and no test dependencies:
//
//   node test/jump-to-question.test.mjs
//
// Three things are pinned here:
//  1. The upper-area jump actually lands on the user's message. A single Set
//     shared by the candidate element and the resolved turn row silently drops
//     every user message (the host puts data-chat-flow-kind and data-chat-turn
//     on the SAME flow-item element, so row === el), so that bug fails here.
//  2. The jump animates with a native smooth scroll like the lower half's
//     scroll-to-bottom, then holds. A stub scrollTo records the request and
//     completes it through scrollend, mirroring what the browser does.
//  3. When the transcript is paged, a double-click that would reach the top of
//     the loaded content clicks the host's "load earlier" control and retries
//     once the page lands, instead of stopping at the loaded boundary.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    attrs: {},
    dataset: {},
    className: '',
    children: [],
    parentElement: null,
    style: { cssText: '' },
    _listeners: {},
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 600,
    _rect: { top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 },
    _scrollToCalls: [],
  };
  el.setAttribute = (k, v) => {
    el.attrs[k] = String(v);
    if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = String(v);
  };
  el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
  el.hasAttribute = (k) => k in el.attrs;
  el.appendChild = (c) => { c.parentElement = el; el.children.push(c); return c; };
  el.insertBefore = (node, ref) => {
    const i = ref ? el.children.indexOf(ref) : -1;
    if (i < 0) el.children.push(node); else el.children.splice(i, 0, node);
    node.parentElement = el;
    return node;
  };
  el.contains = (n) => { let x = n; while (x) { if (x === el) return true; x = x.parentElement; } return false; };
  el.closest = (sel) => { let x = el; while (x) { if (matches(x, sel)) return x; x = x.parentElement; } return null; };
  el.getBoundingClientRect = () => ({ ...el._rect });
  el.addEventListener = (type, fn) => { (el._listeners[type] ||= []).push(fn); };
  el.querySelector = (sel) => descendants(el).find((d) => matches(d, sel)) || null;
  el.querySelectorAll = (sel) => descendants(el).filter((d) => matches(d, sel));
  // Mirror the browser: scrollTo({behavior:'smooth'}) moves the port later and
  // then fires scrollend; an instant request moves it now.
  el.scrollTo = (opts) => {
    el._scrollToCalls.push({ ...(opts || {}) });
    if (opts && opts.behavior === 'smooth') {
      setTimeout(() => {
        el.scrollTop = opts.top;
        for (const fn of (el._listeners['scrollend'] || []).slice()) fn({ target: el });
      }, 5);
    } else {
      el.scrollTop = (opts || {}).top;
    }
  };
  return el;
}

function descendants(root) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

function matchOne(el, s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '[') {
      const j = s.indexOf(']', i);
      tokens.push(s.slice(i, j + 1));
      i = j + 1;
    } else if (s[i] === '.') {
      i++;
      let k = i; while (k < s.length && /[\w-]/.test(s[k])) k++;
      tokens.push('.' + s.slice(i, k)); i = k;
    } else {
      let k = i; while (k < s.length && /[\w-]/.test(s[k])) k++;
      if (k > i) { tokens.push(s.slice(i, k)); i = k; } else i++;
    }
  }
  return tokens.every((t) => {
    if (t.startsWith('[')) {
      const m = t.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!m) return false;
      return m[2] === undefined ? el.hasAttribute(m[1]) : el.getAttribute(m[1]) === m[2];
    }
    if (t.startsWith('.')) return (el.className || '').split(/\s+/).includes(t.slice(1));
    return el.tagName === t.toUpperCase();
  });
}

function matches(el, sel) { return sel.split(',').some((s) => matchOne(el, s.trim())); }

// A user turn row: the host puts data-chat-flow-kind and data-chat-turn on the
// same element, which is what the plugin's candidate/row dedup has to survive.
function makeRow(turn, top, kind = 'user') {
  const row = makeEl('div');
  row.setAttribute('data-chat-flow-kind', kind);
  row.setAttribute('data-chat-turn', String(turn));
  row._rect = { top, left: 0, width: 700, height: 40, bottom: top + 40, right: 700 };
  return row;
}

function buildDom(opts) {
  const {
    scrollTop = 400, rows = [], clientY = 50, contentRectTop = 100,
    scrollTo = true, loadButton = null,
  } = opts;

  const document = makeEl('#document');
  document.tagName = '#document';
  const body = makeEl('body');
  document.body = body;
  document.documentElement = body;
  document.appendChild(body);
  document.createElement = (tag) => makeEl(tag);
  document.contains = (n) => body.contains(n) || n === document;
  document.querySelector = (sel) => descendants(document).find((d) => matches(d, sel)) || null;
  document.querySelectorAll = (sel) => descendants(document).filter((d) => matches(d, sel));

  const content = makeEl('div');
  content.setAttribute('data-conversation-content', '');
  body.appendChild(content);

  const scroll = makeEl('div');
  scroll.setAttribute('data-conversation-scroll', '');
  scroll.scrollHeight = 1000;
  scroll.clientHeight = 600;
  scroll.scrollTop = scrollTop;
  scroll._rect = { top: contentRectTop, left: 0, width: 800, height: 600, bottom: contentRectTop + 600, right: 800 };
  content.appendChild(scroll);
  if (!scrollTo) delete scroll.scrollTo;

  // The host renders the flow column (data-chat-flow) inside the scrollport,
  // with the paged-history control above the messages.
  const flow = makeEl('div');
  flow.setAttribute('data-chat-flow', '');
  scroll.appendChild(flow);

  const button = { clicks: 0, element: null };
  if (loadButton) {
    const wrapper = makeEl('div');
    wrapper.className = loadButton.className || 'V4vHZW_older';
    const btn = makeEl('button');
    btn.setAttribute('type', 'button');
    btn.textContent = loadButton.label || '加载更早';
    btn.disabled = false;
    wrapper.appendChild(btn);
    flow.appendChild(wrapper);
    btn.click = () => {
      if (btn.disabled) return;
      button.clicks++;
      btn.disabled = true;
      btn.textContent = '加载中…';
      setTimeout(() => {
        if (loadButton.onLoad) {
          loadButton.onLoad({ flow, scroll, contentRectTop, scrollTop, makeRow, button: btn, wrapper });
        } else {
          btn.disabled = false;
          btn.textContent = loadButton.label || '加载更早';
        }
      }, loadButton.delay || 120);
    };
    button.element = btn;
  }

  for (const r of rows) flow.appendChild(r);
  return { document, scroll, flow, clientY, button };
}

async function dispatch(file, opts) {
  const src = fs.readFileSync(file, 'utf8');
  const captured = {};
  const dom = buildDom(opts);
  const { document, scroll, clientY, button } = dom;
  const sandbox = {
    window: {
      location: { href: 'http://127.0.0.1:1456/' },
      document,
      __ModuleLoader__: { load: (o) => { captured.factory = o.factory; } },
    },
    document,
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });

  captured.factory(() => ({})).apply({});

  const handlers = scroll._listeners['dblclick'] || [];
  if (!handlers.length) throw new Error('no dblclick handler attached to the scrollport');
  let target = opts.target;
  if (!target && opts.targetIsButton) target = dom.button.element;
  if (!target) target = scroll.children[0] || scroll;
  const before = scroll.scrollTop;
  handlers[0]({ target, clientY, preventDefault() {}, stopPropagation() {} });
  // Let the native-animation fallback, the history-load poll and the retry settle.
  await new Promise((r) => setTimeout(r, opts.waitMs || 700));
  return { before, after: scroll.scrollTop, scrollToCalls: scroll._scrollToCalls || [], clicks: button.clicks };
}

const SCENARIOS = [
  {
    name: 'upper: not aligned parks the nearest user message (animated)',
    opts: { scrollTop: 400, rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)] },
    expected: 286,
    expectSmooth: true,
  },
  {
    name: 'upper: repeated double-click steps one user message further up',
    opts: { scrollTop: 400, rows: [makeRow(0, 60), makeRow(1, 100), makeRow(2, 500)] },
    expected: 336,
    expectSmooth: true,
  },
  {
    name: 'upper: already on the first message goes to the very top',
    opts: { scrollTop: 400, rows: [makeRow(0, 100), makeRow(1, 200), makeRow(2, 500)] },
    expected: 0,
    expectSmooth: true,
  },
  {
    name: 'upper: no mounted user message leaves the scrollport untouched',
    opts: { scrollTop: 400, rows: [] },
    expected: 400,
    expectSmooth: false,
  },
  {
    name: 'lower: double-click still scrolls to the bottom (animated)',
    opts: { scrollTop: 100, rows: [makeRow(0, 100)], clientY: 700 },
    expected: 1000,
    expectSmooth: true,
  },
  {
    name: 'upper: scrollport without scrollTo still snaps to the message',
    opts: { scrollTop: 400, rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)], scrollTo: false },
    expected: 286,
    expectSmooth: false,
  },
  // ---- paged history ----
  {
    name: 'paged: top-of-transcript double-click loads one page, then jumps to it',
    opts: {
      scrollTop: 400,
      rows: [makeRow(5, 200), makeRow(6, 240), makeRow(7, 500)],
      loadButton: {
        onLoad: ({ flow, makeRow }) => {
          // The host keeps the viewport anchored, so the new page appears above
          // the viewport; the control is gone because history is exhausted.
          flow.children.unshift(makeRow(4, 0));
          flow.children[0].parentElement = flow;
          const wrapper = flow.children.find((c) => c.className && c.className.includes('older'));
          if (wrapper) flow.children.splice(flow.children.indexOf(wrapper), 1);
        },
      },
    },
    expected: 276,
    expectClicks: 1,
    waitMs: 900,
  },
  {
    name: 'paged: no control means the jump to the top proceeds untouched',
    opts: { scrollTop: 400, rows: [makeRow(5, 200), makeRow(6, 240), makeRow(7, 500)] },
    expected: 0,
    expectSmooth: true,
    expectClicks: 0,
  },
  {
    name: 'paged: control present but the target is already loaded does not load',
    opts: {
      scrollTop: 400,
      rows: [makeRow(1, 0), makeRow(2, 120)],
      loadButton: { onLoad: () => {} },
    },
    expected: 276,
    expectSmooth: true,
    expectClicks: 0,
  },
  {
    name: 'paged: double-click on the control itself leaves it to the host',
    opts: {
      scrollTop: 400,
      rows: [makeRow(5, 200), makeRow(6, 240)],
      loadButton: { onLoad: () => {} },
      targetIsButton: true,
    },
    expected: 400,
    expectClicks: 0,
    waitMs: 900,
  },
  {
    name: 'paged: empty transcript with a control loads before jumping',
    opts: {
      scrollTop: 400,
      rows: [],
      loadButton: {
        onLoad: ({ flow, makeRow }) => {
          flow.children.unshift(makeRow(1, 0));
          flow.children[0].parentElement = flow;
          const wrapper = flow.children.find((c) => c.className && c.className.includes('older'));
          if (wrapper) flow.children.splice(flow.children.indexOf(wrapper), 1);
        },
      },
    },
    expected: 276,
    expectClicks: 1,
    waitMs: 900,
  },
  {
    name: 'paged: loading is capped at three pages per gesture',
    opts: {
      scrollTop: 400,
      rows: [makeRow(5, 200), makeRow(6, 240), makeRow(7, 500)],
      // The control stays present and enabled after every page, so each retry
      // would ask for another one; the cap must stop it after three and then
      // fall through to the ordinary jump.
      loadButton: {},
    },
    expected: 0,
    expectClicks: 3,
    waitMs: 2500,
  },
];

let failures = 0;
for (const s of SCENARIOS) {
  const opts = { ...s.opts };
  const r = await dispatch(CLIENT, opts);
  const landed = r.after === s.expected;
  const smooth = (r.scrollToCalls[0] || {}).behavior === 'smooth';
  const animationOk = s.expectSmooth === undefined ? true : (s.expectSmooth ? smooth : !smooth);
  const clicksOk = s.expectClicks === undefined ? true : r.clicks === s.expectClicks;
  const pass = landed && animationOk && clicksOk;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${s.name}`);
  console.log(`      scrollTop ${r.before} -> ${r.after} (expected ${s.expected}); clicks=${r.clicks} (expected ${s.expectClicks ?? 'any'}); scrollTo=${JSON.stringify(r.scrollToCalls)}`);
}
console.log(failures === 0 ? '\nAll scenarios passed.' : `\n${failures} scenario(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
