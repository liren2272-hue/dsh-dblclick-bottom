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
  el.removeEventListener = (type, fn) => { if (el._listeners[type]) el._listeners[type] = el._listeners[type].filter((f) => f !== fn); };
  el.querySelector = (sel) => descendants(el).find((d) => matches(d, sel)) || null;
  el.querySelectorAll = (sel) => descendants(el).filter((d) => matches(d, sel));
  el.dispatchEvent = (ev) => {
    const type = ev && ev.type;
    if (type === 'pointerdown') el._pointerdowns = (el._pointerdowns || 0) + 1;
    for (const fn of (el._listeners[type] || []).slice()) fn(ev);
    return true;
  };
  // Mirror the host: it retains a paging anchor while history is loading and
  // re-parks the scrollport on that anchor after each commit — and it ONLY drops
  // the anchor on a pointerdown (READING_INTENTS -> onIntent -> stopPreserving).
  el._hostPagingAnchor = null;
  el.addEventListener('pointerdown', () => { el._hostPagingAnchor = null; });
  el._hostRepark = () => {
    if (el._hostPagingAnchor !== null) el.scrollTop = el._hostPagingAnchor;
  };
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
    Event: class {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = !!init.bubbles;
        this.cancelable = !!init.cancelable;
        this.target = null;
      }
    },
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
  const makeEvt = () => ({ target, clientY, preventDefault() {}, stopPropagation() {} });
  // The upper gesture is counted from raw clicks, so fire the container's click
  // listeners directly (the harness never renders). A `prefixClickCount` models
  // a preceding upper double-click (whose walk-up may still be in flight); the
  // `gapMs` between it and the rapid clicks models "wait a while vs. do it
  // immediately" — the walk-up may already have settled during the gap.
  const wantClicks = opts.clickCount || opts.prefixClickCount;
  if (wantClicks) {
    const clickHandlers = scroll._listeners['click'] || [];
    if (!clickHandlers.length) throw new Error('no click handler attached to the scrollport');
    const fireClicks = (n) => { for (let i = 0; i < n; i++) for (const fn of clickHandlers) fn(makeEvt()); };
    if (opts.prefixClickCount) fireClicks(opts.prefixClickCount);
    if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
    if (opts.clickCount) fireClicks(opts.clickCount);
  } else {
    handlers[0](makeEvt());
  }
  // After the gesture settles, optionally simulate a REAL user scroll down (a
  // trusted pointerdown/wheel) and observe whether the park loop fights it.
  if (opts.afterGesture) {
    opts.afterGesture({ scroll, makeRow, flow: dom.flow, isTrusted: (t) => ({ type: t, isTrusted: true }) });
  }
  // Let the native-animation fallback, the history-load poll and the retry settle.
  await new Promise((r) => setTimeout(r, opts.waitMs || 700));
  return {
    before,
    after: scroll.scrollTop,
    scrollToCalls: scroll._scrollToCalls || [],
    clicks: button.clicks,
    pointerdowns: scroll._pointerdowns || 0,
  };
}

const SCENARIOS = [
  {
    name: 'upper: not aligned parks the nearest user message (animated)',
    opts: { scrollTop: 400, rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)], clickCount: 2 },
    expected: 286,
    expectSmooth: true,
    waitMs: 900,
  },
  {
    name: 'upper: repeated double-click steps one user message further up',
    opts: { scrollTop: 400, rows: [makeRow(0, 60), makeRow(1, 100), makeRow(2, 500)], clickCount: 2 },
    expected: 336,
    expectSmooth: true,
    waitMs: 900,
  },
  {
    name: 'upper: already on the first message goes to the very top',
    opts: { scrollTop: 400, rows: [makeRow(0, 100), makeRow(1, 200), makeRow(2, 500)], clickCount: 2 },
    expected: 0,
    expectSmooth: true,
    waitMs: 900,
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
    opts: { scrollTop: 400, rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)], scrollTo: false, clickCount: 2 },
    expected: 286,
    expectSmooth: false,
    waitMs: 900,
  },
  // ---- paged history ----
  {
    name: 'paged: top-of-transcript double-click loads one page, then jumps to it',
    opts: {
      scrollTop: 400,
      rows: [makeRow(5, 200), makeRow(6, 240), makeRow(7, 500)],
      clickCount: 2,
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
    opts: { scrollTop: 400, rows: [makeRow(5, 200), makeRow(6, 240), makeRow(7, 500)], clickCount: 2 },
    expected: 0,
    expectSmooth: true,
    expectClicks: 0,
    waitMs: 900,
  },
  {
    name: 'paged: control present but the target is already loaded does not load',
    opts: {
      scrollTop: 400,
      rows: [makeRow(1, 0), makeRow(2, 120)],
      clickCount: 2,
      loadButton: { onLoad: () => {} },
    },
    expected: 276,
    expectSmooth: true,
    expectClicks: 0,
    waitMs: 900,
  },
  {
    name: 'paged: double-click on the control itself leaves it to the host',
    opts: {
      scrollTop: 400,
      rows: [makeRow(5, 200), makeRow(6, 240)],
      clickCount: 2,
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
      clickCount: 2,
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
      clickCount: 2,
      // The control stays present and enabled after every page, so each retry
      // would ask for another one; the cap must stop it after three and then
      // fall through to the ordinary jump.
      loadButton: {},
    },
    expected: 0,
    expectClicks: 3,
    waitMs: 2500,
  },
  // ---- rapid upper-area clicks -> jump to the very front ----
  {
    name: 'rapid: 2 upper-area clicks do not trigger the front jump',
    opts: {
      scrollTop: 400,
      rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)],
      clickCount: 2,
    },
    expected: 286,
    expectSmooth: true,
    expectClicks: 0,
    waitMs: 900,
  },
  {
    // The upper double-click is DELAYED by a grace so a rapid triple supersedes
    // it and jumps straight to the very top (one continuous glide), instead of
    // first animating a walk-up to the previous message. Here 2 clicks start the
    // deferred walk-up, then a 3rd click lands inside the grace and the triple
    // must win: the port must go to 0, and the walk-up (which would target 286)
    // must NOT have fired. expectClicks: 2 proves only the aggressive front jump
    // loaded history, and the scrollTo should land at 0 (not 286).
    name: 'rapid: a 3rd click inside the grace supersedes the deferred double walk-up',
    opts: (() => {
      let loads = 0;
      return {
        scrollTop: 400,
        rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)],
        prefixClickCount: 2,
        clickCount: 3,
        loadButton: {
          onLoad: ({ flow, makeRow, button }) => {
            loads++;
            if (loads === 1) {
              flow.children.unshift(makeRow(4, 0));
              flow.children[0].parentElement = flow;
              button.disabled = false;
              button.textContent = '加载更早';
            } else {
              const w = flow.children.find((c) => c.className && c.className.includes('older'));
              if (w) flow.children.splice(flow.children.indexOf(w), 1);
            }
          },
        },
      };
    })(),
    expected: 0,
    expectClicks: 2,
    waitMs: 2500,
  },
  {
    name: 'rapid: 3+ upper-area clicks jump to the very front and load every page',
    opts: (() => {
      let loads = 0;
      return {
        scrollTop: 400,
        rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)],
        clickCount: 3,
        loadButton: {
          onLoad: ({ flow, makeRow, button }) => {
            loads++;
            if (loads === 1) {
              // One more page above the viewport; the control stays so the
              // aggressive gesture has to click it a second time.
              flow.children.unshift(makeRow(4, 0));
              flow.children[0].parentElement = flow;
              button.disabled = false;
              button.textContent = '加载更早';
            } else {
              // History exhausted: the host removes the control.
              const w = flow.children.find((c) => c.className && c.className.includes('older'));
              if (w) flow.children.splice(flow.children.indexOf(w), 1);
            }
          },
        },
      };
    })(),
    expected: 0,
    expectClicks: 2,
    waitMs: 2500,
  },
  {
    // Regression for the "first gesture only parks at the load-earlier row,
    // needs a second gesture to reach the very top" bug. The host retains a
    // paging anchor and re-parks the scrollport on it after each commit, AND it
    // only drops that anchor on a pointerdown (READING_INTENTS -> onIntent ->
    // stopPreserving). So a mere scroll write is fought forever; the fix must
    // dispatch a pointerdown to release the anchor, then glide to 0 and hold.
    name: 'rapid: first gesture parks at the very top, not the load-earlier row',
    opts: (() => {
      let loads = 0;
      return {
        scrollTop: 400,
        rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)],
        clickCount: 3,
        loadButton: {
          onLoad: ({ flow, scroll, makeRow, button }) => {
            loads++;
            if (loads === 1) {
              // The host keeps the viewport anchored on the oldest visible row
              // (where the control was). It will re-park here after every commit
              // until a pointerdown releases the anchor.
              scroll._hostPagingAnchor = 276;
              flow.children.unshift(makeRow(4, 0));
              flow.children[0].parentElement = flow;
              scroll.scrollTop = 276;
              button.disabled = false;
              button.textContent = '加载更早';
            } else {
              const w = flow.children.find((c) => c.className && c.className.includes('older'));
              if (w) flow.children.splice(flow.children.indexOf(w), 1);
              // The host keeps re-parking at the anchor on late layout passes
              // (images, markdown, code blocks) — including one that lands AFTER
              // the brief "stable at the top" window a shorter loop would have
              // used to stop. Without the long-lived watchdog the port would
              // strand at 276 and need a second gesture.
              for (const t of [300, 700, 1100, 1600, 2200]) setTimeout(() => scroll._hostRepark(), t);
            }
          },
        },
      };
    })(),
    expected: 0,
    expectClicks: 2,
    waitMs: 3000,
  },
  {
    // The deliberate pointerdown is what releases the host anchor. Verify that
    // WITHOUT it the port stays stranded at the load-earlier row (so the fix is
    // real, not incidental), by counting the pointerdowns parkAtTop dispatches.
    // The late repark at 2200ms proves the watchdog (not a short hold) is what
    // defends the top.
    name: 'rapid: parkAtTop dispatches a pointerdown to release the host anchor',
    opts: (() => {
      let loads = 0;
      return {
        scrollTop: 400,
        rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)],
        clickCount: 3,
        loadButton: {
          onLoad: ({ flow, scroll, makeRow, button }) => {
            loads++;
            if (loads === 1) {
              scroll._hostPagingAnchor = 276;
              flow.children.unshift(makeRow(4, 0));
              flow.children[0].parentElement = flow;
              scroll.scrollTop = 276;
              button.disabled = false;
              button.textContent = '加载更早';
            } else {
              const w = flow.children.find((c) => c.className && c.className.includes('older'));
              if (w) flow.children.splice(flow.children.indexOf(w), 1);
              for (const t of [300, 700, 1100, 1600, 2200]) setTimeout(() => scroll._hostRepark(), t);
            }
          },
        },
      };
    })(),
    // Captured by the two assertions below via a side channel.
    expected: 0,
    expectClicks: 2,
    waitMs: 3000,
    extra: (r) => r.pointerdowns > 0,
  },
  {
    // Regression for the "after the top-park I have to wait before I can scroll
    // down" bug. The park loop must stop on a REAL user gesture, otherwise it
    // fights a downward scroll for its whole 5s window. Here the host anchor is
    // already released (no host repark on a timer); the only thing that must not
    // fight is the plugin's own hold loop. Fire a trusted pointerdown AFTER the
    // park is live, then scroll down; the port must stay down.
    name: 'rapid: a real scroll-down after the park is not fought by the hold loop',
    opts: (() => {
      let loads = 0;
      return {
        scrollTop: 400,
        rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)],
        clickCount: 3,
        loadButton: {
          onLoad: ({ flow, scroll, makeRow, button }) => {
            loads++;
            if (loads === 1) {
              scroll._hostPagingAnchor = 276;
              flow.children.unshift(makeRow(4, 0));
              flow.children[0].parentElement = flow;
              scroll.scrollTop = 276;
              button.disabled = false;
              button.textContent = '加载更早';
            } else {
              const w = flow.children.find((c) => c.className && c.className.includes('older'));
              if (w) flow.children.splice(flow.children.indexOf(w), 1);
              // A late anchor re-park after parkAtTop's short window would have
              // stopped: the watchdog must still defend, then yield to a real scroll.
              for (const t of [300, 700, 1600, 2200]) setTimeout(() => scroll._hostRepark(), t);
            }
          },
        },
        // Fired right after the 3 clicks; schedule the trusted user scroll-down
        // for well after the aggressive load has finished and parkAtTop is live
        // (the 2nd page lands ~320ms, parkAtTop attaches its cancel listener then),
        // and even after the 2200ms late host re-park. A real trusted gesture must
        // immediately stop the watchdog and leave the port at the scrolled-down spot.
        afterGesture: ({ scroll, isTrusted }) => {
          // A REAL trusted user scroll-down, fired after the park is live (and after
          // any late host re-park). The watchdog must cancel itself and leave the
          // port at the scrolled-down spot instead of fighting back to 0.
          setTimeout(() => {
            scroll.dispatchEvent(isTrusted('pointerdown'));
            scroll.scrollTop = 600;
          }, 2600);
        },
      };
    })(),
    expected: 600,
    expectClicks: 2,
    waitMs: 3200,
  },
  {
    // Regression for "double-click (walk up one) then triple-click immediately:
    // only reaches the previous message, not the very top, unless I wait". The
    // double-click fires a walk-up; before the 3rd click the walk-up is still in
    // flight (loading older history / animating), and it must be superseded by the
    // aggressive front jump so the first combined gesture parks at the very top.
    name: 'rapid: double-click then immediate triple-click parks at the very top',
    opts: (() => {
      let loads = 0;
      return {
        scrollTop: 400,
        rows: [makeRow(0, 0), makeRow(1, 10), makeRow(2, 500)],
        prefixClickCount: 2,
        clickCount: 3,
        loadButton: {
          onLoad: ({ flow, scroll, makeRow, button }) => {
            loads++;
            if (loads === 1) {
              scroll._hostPagingAnchor = 276;
              flow.children.unshift(makeRow(4, 0));
              flow.children[0].parentElement = flow;
              scroll.scrollTop = 276;
              button.disabled = false;
              button.textContent = '加载更早';
            } else {
              const w = flow.children.find((c) => c.className && c.className.includes('older'));
              if (w) flow.children.splice(flow.children.indexOf(w), 1);
              for (const t of [300, 700, 1100, 1600]) setTimeout(() => scroll._hostRepark(), t);
            }
          },
        },
      };
    })(),
    expected: 0,
    expectClicks: 2,
    waitMs: 2500,
  },
  {
    // TRUE regression guard for the "double-click (walk up) then immediate
    // triple-click only reaches the previous message, not the very top, unless I
    // wait" bug. The fix in jumpToFront.step must WAIT for an in-flight load
    // (the control present but DISABLED) instead of bailing to the park.
    //
    // This is the only scenario that actually disables the control before the
    // aggressive jump starts: the upper double-click walks up with an EMPTY
    // mounted transcript, so jumpToQuestion hits the rows.length===0 branch and
    // calls loadOlderHistory, which clicks the control and disables it while the
    // older page is in flight. The very next instant the 3 rapid clicks fire and
    // jumpToFront begins against a *disabled* control.
    //
    //  - NEW code: jumpToFront waits for the control to re-enable, then clicks it
    //    a second time to load the remaining page and park at the very top.
    //    => button.clicks === 2 (walk-up + aggressive), scrollTop ends at 0.
    //  - OLD code: step(0) used findLoadEarlierButton(..., true), which returns
    //    null for a disabled control, so it bailed straight to done()/parkAtTop
    //    after only the walk-up's click. => button.clicks === 1, and the older
    //    page the aggressive jump should have pulled was never loaded.
    // So expectClicks: 2 is what fails on the old (buggy) behavior.
    name: 'rapid: double-click disabling in-flight load then triple-click still reaches the very top',
    opts: (() => {
      let loads = 0;
      return {
        scrollTop: 400,
        rows: [], // empty mounted transcript -> walk-up triggers loadOlderHistory
        prefixClickCount: 2,
        clickCount: 3,
        loadButton: {
          onLoad: ({ flow, scroll, makeRow, button }) => {
            loads++;
            if (loads === 1) {
              // The superseded walk-up clicked the control and started loading.
              // Re-enable it with the same label so the aggressive front jump can
              // take over and pull the remaining page to the very top.
              flow.children.unshift(makeRow(4, 0));
              flow.children[0].parentElement = flow;
              button.disabled = false;
              button.textContent = '加载更早';
            } else {
              // History exhausted: the host removes the control.
              const w = flow.children.find((c) => c.className && c.className.includes('older'));
              if (w) flow.children.splice(flow.children.indexOf(w), 1);
            }
          },
        },
      };
    })(),
    expected: 0,
    expectClicks: 2,
    waitMs: 2500,
  },
];

let failures = 0;
for (const s of SCENARIOS) {
  const opts = { ...s.opts, waitMs: s.waitMs };
  const r = await dispatch(CLIENT, opts);
  const landed = r.after === s.expected;
  const smooth = (r.scrollToCalls[0] || {}).behavior === 'smooth';
  const animationOk = s.expectSmooth === undefined ? true : (s.expectSmooth ? smooth : !smooth);
  const clicksOk = s.expectClicks === undefined ? true : r.clicks === s.expectClicks;
  const extraOk = s.extra ? s.extra(r) : true;
  const pass = landed && animationOk && clicksOk && extraOk;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${s.name}`);
  console.log(`      scrollTop ${r.before} -> ${r.after} (expected ${s.expected}); clicks=${r.clicks} (expected ${s.expectClicks ?? 'any'}); pointerdowns=${r.pointerdowns ?? 0}; scrollTo=${JSON.stringify(r.scrollToCalls)}`);
}
console.log(failures === 0 ? '\nAll scenarios passed.' : `\n${failures} scenario(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
