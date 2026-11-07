window.__ModuleLoader__.load({
  id: '@local/dsh-dblclick-bottom',
  factory(require) {
    'use strict';

    const CONVERSATION_SELECTOR = '[data-conversation-scroll]';
    const SIDE_COLUMN_SELECTOR = '[data-sidebar-right-panel]';
    const BOTTOM_THRESHOLD = 0.72;
    const TOP_THRESHOLD = 0.28;

    function inSideColumn(node) {
      try { return node && node.closest && node.closest(SIDE_COLUMN_SELECTOR) != null; }
      catch (e) { return false; }
    }

    function conversationNode() {
      try {
        const all = [...document.querySelectorAll(CONVERSATION_SELECTOR)];
        if (all.length === 0) return null;
        const main = all.filter((n) => !inSideColumn(n));
        const pool = main.length > 0 ? main : all;
        if (pool.length === 1) return pool[0];
        let best = null, bestArea = -1;
        for (const n of pool) {
          const r = n.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > bestArea) { bestArea = area; best = n; }
        }
        return best;
      } catch (e) { return null; }
    }

    function nearestScrollContainer(target) {
      try {
        if (target && target.closest) {
          const c = target.closest(CONVERSATION_SELECTOR);
          if (c) return c;
        }
      } catch (e) {}
      return conversationNode();
    }

    /**
     * Whether a flow item belongs to the same conversation subtree as the
     * container the double-click landed in. The plugin attaches to every
     * [data-conversation-scroll], including side-column copies, so a bare
     * contains() check would reject the main transcript whenever the two are
     * siblings rather than nested.
     */
    function conversationScope(container) {
      try {
        if (container.closest) {
          const body = container.closest('[data-conversation-content]');
          if (body !== null) return body;
        }
      } catch (e) {}
      return container;
    }

    // Selector for the user's own messages (the host renders them with
    // data-chat-flow-kind="user"; "steering" rows are the same author's
    // injected instructions, so they are included as well).
    const USER_TURN_SELECTOR = '[data-chat-flow-kind="user"],[data-chat-flow-kind="steering"]';
    const TURN_ROW_SELECTOR = '[data-chat-turn]';

    // The host renders its paged-history control above the oldest loaded content
    // (chat.js ChatView: hasMore && jsx("div", { className: older }, button)).
    // Its label is localized; match the known strings and fall back to the
    // CSS-module wrapper class (the local name is "older").
    const LOAD_EARLIER_TEXT = /^(加载更早|加载更多|加载更早的消息|加载更早内容|加载历史消息|Load earlier|Load more|Load older|Load earlier messages|Load history)$/i;
    const LOAD_EARLIER_CLASS = /(^|[_-])older([_-]|$)/;
    // One double-click gesture may pull at most this many history pages before
    // it gives up and jumps within what is already loaded.
    const MAX_AUTO_LOAD = 3;

    // "Jump to the very front": 3+ clicks in the upper region inside a short
    // window switches the upper-area gesture from walking up message by message
    // to loading every paged history page and parking at the very top.
    const RAPID_CLICK_COUNT = 3;
    const RAPID_CLICK_WINDOW = 2500;
    // A double-tap walk-up in the upper area is deferred by this grace so a third
    // click landing within it is recognized as a triple (jump to the very top)
    // instead of first animating to the previous message. Kept short so a real
    // double-click still feels immediate; only rapid triples merge into one
    // continuous glide to the very top.
    const DOUBLE_GRACE_MS = 360;
    // Bounds for the aggressive load-all mode: a chat with a very long paged
    // history cannot loop forever if the host never removes its control.
    const MAX_ALL_LOAD = 60;
    const PAGE_TIMEOUT = 15000;

    // Set while the aggressive "jump to the very front" gesture is loading
    // history; suppresses the ordinary upper-area double-click walk so the two
    // cannot fight over the scrollport.
    let frontJumpInFlight = false;
    // Set while the aggressive "jump to the very front" gesture is loading
    // history. An upper-area double-click that started walking up a message just
    // before the rapid burst fired must abort, otherwise the two fight over the
    // scrollport and the park-at-top loses. The native dblclick listener still
    // handles a real upper double-click when no front jump is in flight.
    let walkAbort = false;
    // Monotonic id of the current front-park. Each jumpToFront bumps it; any
    // lingering watchdog/hold from a previous park keeps comparing against this
    // and stops itself, so an older park cannot fight a newer gesture.
    let parkId = 0;

    // A native smooth glide emits roughly one scroll event per animation frame
    // for a second and a half, and on the host every one of those is answered
    // with layout work: onScroll -> readScroll/invalidate, then at scrollend
    // acknowledge -> reclaimBelow (a spacer height write) -> refreshActiveTurn
    // -> readVisibleTurn's O(all rows) probe over a transcript that is NOT
    // virtualized (the chat bundle's only useVirtualizer is the turn rail; every
    // loaded message stays mounted). Measured on a b04b03-shaped DOM of 270k
    // elements, one smooth "scroll to bottom" fired 67 scroll events and 2
    // scrollends where the same destination reached by an instant write fired 1
    // and 0. The headline gestures keep their slide anyway (see below); the gate
    // exists so the park's repeated re-assert ticks and the upper walk-up cannot
    // multiply that cost.
    // The two headline gestures — lower double-click to the bottom and the
    // upper triple-click to the very front — keep their slide no matter how far
    // they travel; snapping them reads as the feature being broken. Everything
    // else (the park's re-assert ticks, the upper walk-up past a huge turn)
    // stays on the distance gate below.
    const SMOOTH_MAX_VP = 6;

    // Request a smooth glide, or — for the distance-gated callers — write the
    // offset directly once the jump is more than a few screens. Returns true
    // only when a smooth request was actually issued, so callers keep their
    // scrollend bookkeeping tied to a real animation. No clamping here: the
    // browser clamps both forms.
    function glideOrSnap(port, top, opts) {
      const force = !!(opts && opts.forceGlide);
      const viewport = port.clientHeight || 0;
      if (!force && viewport && Math.abs(top - port.scrollTop) > SMOOTH_MAX_VP * viewport) {
        port.scrollTop = top;
        return false;
      }
      port.scrollTo({ top, behavior: 'smooth' });
      return true;
    }

    function scrollToBottom(container) {
      try {
        if (!container) return;
        if (typeof container.scrollTo === 'function') {
          glideOrSnap(container, container.scrollHeight, { forceGlide: true });
        } else {
          container.scrollTop = container.scrollHeight;
        }
      } catch (e) {
        try { container.scrollTop = container.scrollHeight; } catch (e2) {}
      }
    }

    /**
     * Find the host's paged-history button inside the flow column.
     *
     * It is the only <button type="button"> rendered directly in
     * [data-chat-flow] above the messages, so matching its label (or its
     * `*_older` wrapper class) is enough. `enabledOnly` skips the button while a
     * load is already running, which is how the poll detects completion.
     */
    function findLoadEarlierButton(scope, port, enabledOnly) {
      try {
        const flow = (port && port.querySelector && port.querySelector('[data-chat-flow]')) || scope;
        if (!flow || !flow.querySelectorAll) return null;
        // PERF: the host renders this control as ONE direct child wrapper of the
        // flow column, above the messages (host chat bundle: `hasMore &&
        // <div className={css.older}><button type="button" .../></div>`). So the
        // small prefix of flow children is checked first. The full
        // querySelectorAll('button') below then only runs as a last resort for
        // builds that place the control elsewhere — important because this
        // function is polled every 100ms while a page loads, and the host does
        // not virtualize the flow, so a long transcript holds thousands of
        // buttons to walk on each poll.
        const children = flow.children || [];
        const limit = Math.min(children.length, 6);
        for (let i = 0; i < limit; i++) {
          const wrapper = children[i];
          if (!wrapper || !wrapper.querySelector) continue;
          const cls = wrapper.className;
          if (typeof cls !== 'string' || !LOAD_EARLIER_CLASS.test(cls)) continue;
          const b = wrapper.querySelector('button');
          if (!b || b.getAttribute('type') !== 'button') continue;
          if (enabledOnly && b.disabled) continue;
          return b;
        }
        for (const b of flow.querySelectorAll('button')) {
          if (!b || b.getAttribute('type') !== 'button') continue;
          if (enabledOnly && b.disabled) continue;
          const text = (b.textContent || '').trim();
          if (LOAD_EARLIER_TEXT.test(text)) return b;
          const wrapper = b.parentElement;
          const cls = wrapper && wrapper.className;
          if (typeof cls === 'string' && LOAD_EARLIER_CLASS.test(cls)) return b;
        }
      } catch (e) {}
      return null;
    }

    /**
     * Click the host's "load earlier" control and retry once the new page lands.
     *
     * When the transcript is paged, the host keeps the scrollport anchored while
     * the older page loads (loadEarlier -> viewport.beginPaging()). The control
     * is disabled and relabeled while loading, so polling for it to be restored
     * (or removed, when history is exhausted) tells us the page has landed and
     * the newly prepended rows are measurable. A programmatic click does not
     * fire dblclick, so this cannot recurse into the double-click handler.
     *
     * Returns true when a load was started and the caller should return and
     * retry later; false when there is nothing to load and it should proceed.
     */
    function loadOlderHistory(scope, port, attempt, then) {
      try {
        if (attempt >= MAX_AUTO_LOAD) return false;
        const btn = findLoadEarlierButton(scope, port, true);
        if (!btn) return false;
        const label = (btn.textContent || '').trim();
        btn.click();
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try { then(); } catch (e) {}
        };
        const started = Date.now();
        const poll = () => {
          try {
            if (Date.now() - started > 8000) { finish(); return; }
            const now = findLoadEarlierButton(scope, port, false);
            if (!now) { finish(); return; } // history exhausted
            const nowLabel = (now.textContent || '').trim();
            if (nowLabel === label && !now.disabled) { finish(); return; } // page landed
          } catch (e) {}
          setTimeout(poll, 100);
        };
        // Let React commit the disabled/loading state before the first check.
        setTimeout(poll, 200);
        return true;
      } catch (e) { return false; }
    }

    /**
     * Whether a double-click landed on the host's paged-history control. That
     * control owns its own click handler, so the plugin must not also jump.
     */
    function isLoadEarlierControl(target, container) {
      try {
        if (!target || !target.closest) return false;
        // PERF: the clicked element decides on its own. The previous version
        // scanned EVERY <button> in the whole transcript (the host does not
        // virtualize the flow, so a long conversation holds thousands of them)
        // on every single click, in the capture phase. Same predicate, applied
        // to the button the click actually landed on, so the cost is O(depth)
        // instead of O(DOM). A disabled control still owns its click.
        const btn = target.closest('button');
        if (!btn || btn.getAttribute('type') !== 'button') return false;
        if (LOAD_EARLIER_TEXT.test((btn.textContent || '').trim())) return true;
        const wrapper = btn.parentElement;
        const cls = wrapper && wrapper.className;
        return typeof cls === 'string' && LOAD_EARLIER_CLASS.test(cls);
      } catch (e) { return false; }
    }

    /**
     * Upper-area double click: jump to the user's own message and park it at the
     * very top of the viewport. The jump animates like the lower half's
     * scroll-to-bottom instead of snapping.
     *
     * Rules:
     *  - If the viewport is not aligned with any user message, the double-click
     *    parks the nearest user message at the top.
     *  - Repeated double-clicks walk one user message further up the transcript.
     *  - When the first user message is already parked at the top, the next
     *    double-click goes to the very top of the transcript.
     *  - When the jump reaches the very top of the loaded transcript but the
     *    host still has older history paged above it, the "load earlier" control
     *    is clicked automatically and the jump retries once the page lands, so a
     *    double-click near the top keeps walking up instead of stopping at the
     *    loaded boundary.
     *  - The host attributes an offset change to the reader (chat.js readScroll
     *    2148-2155), so a direct write does not trip its tail-follow snap-back;
     *    the write only re-asserts while nothing else has moved the port.
     *  - With no user message mounted, the handler does nothing at all — never
     *    falls back to scrolling to the bottom, which reads as a broken feature.
     */
    function jumpToQuestion(container, attempt) {
      try {
        if (!container) return;
        // The aggressive "jump to the very front" gesture started while this
        // walk-up was still in flight: abandon the walk so the two do not fight
        // over the scrollport. The result the user wants now is the very top.
        if (walkAbort) return;
        attempt = attempt || 0;
        // The host's scrollport is [data-conversation-scroll] itself
        // (chat.js attach: list.closest("[data-conversation-scroll]") ?? list),
        // and its CSS makes the inner chat column non-scrollable, so the
        // container the handler is bound to is the element to scroll. Walk up
        // only as a guard for a fallback container that is not scrollable.
        let viewport = container;
        try {
          let node = container;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 1) { viewport = node; break; }
            node = node.parentElement;
          }
        } catch (e) {}

        // The scrollport is the container the handler is attached to; the host
        // resolves it the same way (chat.js attach: list.closest(
        // "[data-conversation-scroll]") ?? list). The walk-up above only guards
        // against a fallback container that is not itself scrollable.
        const port = (viewport && viewport.scrollHeight > viewport.clientHeight + 1) ? viewport : container;

        // Collect the user's own messages, in transcript order. The host
        // resolves a turn anchor the same way: the flow item whose kind is
        // "user" (chat.js turnNavigationItem), mapped onto its turn row.
        //
        // PERF: search the CONVERSATION SCOPE, not the document. Every
        // candidate had to pass `scope.contains(el)` anyway, so anything
        // outside the scope was scanned and thrown away; with an unvirtualized
        // transcript that is tens of thousands of elements walked on every
        // double-click, and it also picked up side-column copies only to
        // reject them one by one. Keep the same membership rules, just start
        // from the subtree we actually keep.
        const scope = conversationScope(container);
        const candidates = [];
        try {
          if (scope.matches && scope.matches(USER_TURN_SELECTOR)) candidates.push(scope);
        } catch (e) {}
        try {
          for (const el of scope.querySelectorAll(USER_TURN_SELECTOR)) candidates.push(el);
        } catch (e) {}

        const rows = [];
        // Two sets: `seenEl` skips a candidate element that is nested inside
        // another matching element, while `seenRows` dedupes the resolved turn
        // row. They must stay separate because the host puts data-chat-flow-kind
        // ("user") and data-chat-turn on the SAME flow-item element, so row === el
        // and a single shared set would drop every user message.
        const seenEl = new Set();
        const seenRows = new Set();
        // PERF: one getBoundingClientRect per row, reused for the sort and the
        // offset map below. All reads happen before any write, so they are the
        // same values the two extra passes used to re-measure — but the old
        // comparator called gBCR inside the sort (O(n log n) forced layout reads
        // on a giant unvirtualized tree).
        const rects = new Map();
        for (const el of candidates) {
          if (!el || seenEl.has(el)) continue;
          seenEl.add(el);
          if (!scope.contains(el)) continue;
          if (el.closest && el.closest('[hidden]')) continue;
          if (el.closest && el.closest(SIDE_COLUMN_SELECTOR)) continue;
          const row = (el.closest && el.closest(TURN_ROW_SELECTOR)) || el;
          if (seenRows.has(row)) continue;
          seenRows.add(row);
          if (row.hasAttribute && row.hasAttribute('hidden')) continue;
          if (row.closest && row.closest('[hidden]')) continue;
          const r = row.getBoundingClientRect();
          if (r.height === 0) continue;
          rects.set(row, r);
          rows.push(row);
        }
        rows.sort((a, b) => {
          const ta = parseInt(a.getAttribute('data-chat-turn') || '0', 10);
          const tb = parseInt(b.getAttribute('data-chat-turn') || '0', 10);
          if (ta !== tb) return ta - tb;
          const ra = rects.get(a); const rb = rects.get(b);
          return (ra ? ra.top : 0) - (rb ? rb.top : 0);
        });

        if (rows.length === 0) {
          // Nothing is mounted yet. If the transcript is paged, the host shows a
          // "load earlier" control above the flow; pull a page and retry instead
          // of doing nothing. An empty or still-opening transcript has no control
          // to click, so stay put.
          if (loadOlderHistory(scope, port, attempt, () => jumpToQuestion(container, attempt + 1))) return;
          // No user message is mounted (empty transcript, or still loading
          // history). Going to the bottom would look like the feature is broken,
          // so stay put and let the user retry.
          return;
        }

        const containerRect = port.getBoundingClientRect();
        const items = rows.map((row) => {
          const r = rects.get(row) || row.getBoundingClientRect();
          return { row, offset: (r.top - containerRect.top) + port.scrollTop };
        }).sort((a, b) => a.offset - b.offset);

        // Park the user message at the viewport top. The host parks its own
        // turn anchors 24px below the top edge (chat.js scrollToTurn ->
        // align(row, 24, turn)); the same inset is used here so the parked
        // message looks identical to a host turn jump.
        const PARK_INSET = 24;
        const ALIGN_TOLERANCE = 40;

        // Which user message sits at or just above the current viewport top?
        const current = port.scrollTop;
        let idx = -1;
        for (let i = 0; i < items.length; i++) {
          if (items[i].offset <= current + ALIGN_TOLERANCE) idx = i;
          else break;
        }
        const aligned = (idx >= 0 && Math.abs(items[idx].offset - current) < ALIGN_TOLERANCE);

        let dest;
        if (idx < 0) {
          // Scrolled above the first message: land on the very top.
          dest = 0;
        } else if (aligned && idx > 0) {
          // Already parked on a message: step to the previous one.
          dest = items[idx - 1].offset - PARK_INSET;
        } else if (aligned) {
          // Already on the first message: go to the very top of the transcript.
          dest = 0;
        } else {
          dest = items[idx].offset - PARK_INSET;
        }

        // dest === 0 means "as far up as the loaded transcript goes". If the
        // host still has older history paged above that boundary, load a page
        // and retry: the double-click should keep walking up past the loaded
        // edge instead of stopping there.
        if (dest === 0 && attempt < MAX_AUTO_LOAD &&
          loadOlderHistory(scope, port, attempt, () => jumpToQuestion(container, attempt + 1))) {
          return;
        }

        animateScroll(port, dest);
      } catch (e) {
        // Never fall back to scrolling anywhere on an error: an unexplained jump
        // to the bottom is worse than doing nothing.
      }
    }

    /**
     * "Jump to the very front": the aggressive mode behind 3+ rapid upper-area
     * clicks. Where jumpToQuestion walks up one of the user's own messages per
     * gesture and gives up after MAX_AUTO_LOAD paged pages, this keeps clicking
     * the host's "load earlier" control until the transcript is exhausted and
     * then parks the scrollport at the very top — the first message in the
     * conversation.
     *
     * The control is polled the same way loadOlderHistory polls it: a
     * programmatic click does not fire dblclick, so this cannot recurse into the
     * double-click handler. Bounded by MAX_ALL_LOAD pages and PAGE_TIMEOUT per
     * page so a very long paged history cannot loop forever if the host never
     * removes its control.
     */
    function jumpToFront(container) {
      try {
        if (!container) return;
        // The scrollport is [data-conversation-scroll] itself; the walk-up only
        // guards a fallback container that is not scrollable.
        let viewport = container;
        try {
          let node = container;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 1) { viewport = node; break; }
            node = node.parentElement;
          }
        } catch (e) {}
        const port = (viewport && viewport.scrollHeight > viewport.clientHeight + 1) ? viewport : container;
        const scope = conversationScope(container);

        // Park the scrollport at the very top for the WHOLE gesture. We start the
        // park the instant the aggressive jump begins — NOT after history is
        // exhausted — so loading the older pages and the final glide are ONE
        // continuous upward motion, the same way the lower half's double-click is
        // one continuous glide to the bottom. Starting early also means the host's
        // paging-anchor re-park (which would otherwise snap the port to the "load
        // earlier" row between loads) is re-released on every park tick, so there
        // is no separate "jump to the load-earlier position" step before the
        // animation.
        //
        // The host keeps a paging anchor while history is loading and re-parks the
        // scrollport on it during its post-commit layout pass. It ONLY drops that
        // anchor on a "reading intent" (a pointerdown/wheel/keydown), so parkAtTop
        // dispatches a synthetic pointerdown to release it, then glides to 0 and
        // holds. A real user gesture still cancels the park immediately.
        let parkStarted = false;
        const done = () => {
          frontJumpInFlight = false;
          walkAbort = false;
          // History exhausted. The continuous park that began with this gesture is
          // still holding (and still needed, to defend against any late re-park),
          // so we do NOT start a second one — just clear the suppression flags. If
          // for some reason the park never started (e.g. no control was found),
          // start it now so the top is still pinned.
          if (!parkStarted) parkAtTop(port);
        };

        const startPark = () => {
          if (parkStarted) return;
          parkStarted = true;
          parkAtTop(port);
        };

        const step = (attempt) => {
          try {
            if (attempt >= MAX_ALL_LOAD) { done(); return; }
            // The control only exists while older history is still paged above.
            const present = findLoadEarlierButton(scope, port, false);
            if (!present) { done(); return; } // history exhausted: park now
            // A superseded walk-up (the upper-area double-click that fired just
            // before this aggressive jump) may already be loading a page, so the
            // control is present but disabled. Do NOT bail to the park here: that
            // would leave the scrollport parked at the half-loaded position ("only
            // reached the previous conversation"). Wait for the in-flight load to
            // land, then continue from the same attempt (we have not clicked a new
            // page yet) and load every remaining page to the very top.
            if (present.disabled) {
              const started = Date.now();
              const wait = () => {
                try {
                  if (Date.now() - started > PAGE_TIMEOUT) { done(); return; }
                  const now = findLoadEarlierButton(scope, port, false);
                  if (!now) { done(); return; } // landed and exhausted meanwhile
                  if (!now.disabled) { step(attempt); return; } // ready: click it
                } catch (e) {}
                setTimeout(wait, 100);
              };
              setTimeout(wait, 100);
              return;
            }
            const label = (present.textContent || '').trim();
            present.click();
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              try { step(attempt + 1); } catch (e) {}
            };
            const started = Date.now();
            const poll = () => {
              try {
                if (Date.now() - started > PAGE_TIMEOUT) { finish(); return; }
                const now = findLoadEarlierButton(scope, port, false);
                if (!now) { finish(); return; } // history exhausted
                const nowLabel = (now.textContent || '').trim();
                if (nowLabel === label && !now.disabled) { finish(); return; } // page landed
              } catch (e) {}
              setTimeout(poll, 100);
            };
            // Let React commit the disabled/loading state before the first check.
            setTimeout(poll, 200);
          } catch (e) {
            done();
          }
        };
        frontJumpInFlight = true;
        walkAbort = true;
        startPark();
        step(0);
      } catch (e) {
        try { frontJumpInFlight = false; walkAbort = false; } catch (e2) {}
      }
    }

    /**
     * Glide the scrollport to the very top after the aggressive "load earlier"
     * loop finishes, and hold it there.
     *
     * Root cause of the "needs a second gesture to pin to the top" bug: the host
     * keeps a paging anchor while history is loading and re-parks the scrollport
     * on that retained row during its post-commit layout pass (beginPaging/
     * preserve in the host chat bundle). The host ONLY drops that anchor on a
     * "reading intent" — a pointerdown/wheel/keydown on the scrollport
     * (READING_INTENTS + onIntent -> stopPreserving in the host bundle). So a
     * mere scroll write is fought forever; the user's extra real click worked
     * only because that click released the anchor.
     *
     * Fix: release the host anchor deliberately (dispatch a pointerdown on the
     * scrollport — the same signal a user tap sends), then smooth-glide to 0
     * with the lower-half's primitive. A short hold loop re-releases and
     * re-glides while the port is still off the top, so a re-park that lands
     * within a few hundred ms is absorbed.
     *
     * The host, however, can re-park LATE — after images, code blocks or
     * markdown have committed, often well beyond the first settle, and even
     * after a brief idle at the top. A short hold loop that stops on
     * "stable for a few reads" would miss that late re-park and the port would
     * drift back down, which reads as "only reached the previous spot" and makes
     * the user wait before they can do anything. So a long-lived watchdog keeps
     * re-releasing the anchor for up to PARK_MAX_MS; every time the port is off
     * the top OR the host re-parks (scroll event whose target we did not write),
     * the watchdog re-arms itself, so a late re-park after a short settle is
     * still caught. A real trusted user gesture (tap/wheel/key) ends it.
     *
     * The hold loop MUST stop on a REAL user gesture. Otherwise, after the park
     * completed, scrolling down (or a lower-area double-click that scrolls to the
     * bottom) would be fought by the loop for its whole 5s window, and the user
     * would have to wait for it to expire. A real pointerdown/wheel/keydown is
     * trusted (event.isTrusted === true); the synthetic pointerdown we dispatch
     * to release the host anchor is NOT, so it does not abort the hold.
     */
    function releaseHostAnchor(port) {
      try {
        // The host listens for these intents ON the scrollport, in capture phase
        // (host chat bundle: `for (const type of READING_INTENTS)
        // scroller.addEventListener(type, this.onIntent, {capture:true})`), and a
        // listener registered on the event's target fires in the target phase
        // whether or not the event bubbles — so the anchor release is unaffected
        // by NOT bubbling. Bubbling was actively harmful: this is dispatched
        // repeatedly by the hold loop below, and every trip up the tree walks the
        // whole React ancestor chain and also reaches a SECOND reading-intent
        // layer inside the chat view (`follow.interrupt(...)` on pointerdown over
        // the flow body) whose layout reads we have no reason to provoke. A bare
        // pointerdown carries no coordinates, so it starts no selection or scroll.
        const ev = new Event('pointerdown', { bubbles: false, cancelable: true });
        port.dispatchEvent(ev);
      } catch (e) {}
    }

    // How long the park at the very top keeps defending against late host
    // re-parks. Long enough to outlast image/markdown/code-block layout commits
    // (which can fire seconds after the scroll has settled), but short enough
    // that a user who wants to scroll down is only briefly held.
    const PARK_MAX_MS = 6000;

    // Wake-up cadence of the hold loop. It used to be 90ms — up to ~66 ticks per
    // park, each one dispatching a pointerdown and starting a fresh smooth glide
    // over a scrollport whose content is tens of thousands of live elements. Every
    // one of those writes drives the host's own scroll machinery (onScroll ->
    // readScroll/invalidate, scrollend -> acknowledge -> reclaimBelow spacer write
    // -> refreshActiveTurn's O(DOM) row probe), so the loop was multiplying host
    // work, not plugin work. 300ms is still well inside the window where a late
    // host re-park is visible as "it slid back down", and cuts that multiplier by
    // more than 3x (<= ~20 ticks per park).
    const HOLD_TICK_MS = 300;

    function parkAtTop(port) {
      if (!port) return;
      const target = 0;
      const id = ++parkId; // supersede any earlier park still running
      try {
        // Drop the host's retained paging anchor first, so it stops fighting us.
        releaseHostAnchor(port);
        const max = Math.max(0, port.scrollHeight - port.clientHeight);
        const top = Math.min(target, max);
        // The triple-click to the very front is one continuous upward slide, the
        // same way the lower half's double-click is one continuous slide to the
        // bottom — so the park's FIRST move always glides, even from the bottom
        // of a long transcript. Only the re-assert ticks below fall back to the
        // distance gate, so defending the top never multiplies host work.
        try { glideOrSnap(port, top, { forceGlide: true }); }
        catch (e) { try { port.scrollTop = top; } catch (e2) {} }

        let cancelled = false;
        const detached = () => (cancelled || id !== parkId);
        const detach = () => {
          try { port.removeEventListener('pointerdown', onUserIntent, true); } catch (e) {}
          try { port.removeEventListener('wheel', onUserIntent, true); } catch (e) {}
          try { port.removeEventListener('keydown', onUserIntent, true); } catch (e) {}
          try { port.removeEventListener('scroll', onHostScroll, true); } catch (e) {}
        };
        // A REAL, trusted user gesture (tap / wheel / key) ends the park
        // immediately so a later downward scroll is never fought. The synthetic
        // pointerdown we dispatch above is untrusted and is ignored here.
        const onUserIntent = (ev) => {
          if (ev && ev.isTrusted) { cancelled = true; detach(); }
        };
        // A scroll that we did not write (no park wrote it just now) is a host
        // re-park landing late; re-arm the watchdog so it gets re-released.
        const onHostScroll = () => {
          if (detached()) return;
          if (port.scrollTop > 1) rearm();
        };
        try { port.addEventListener('pointerdown', onUserIntent, true); } catch (e) {}
        try { port.addEventListener('wheel', onUserIntent, true); } catch (e) {}
        try { port.addEventListener('keydown', onUserIntent, true); } catch (e) {}
        try { port.addEventListener('scroll', onHostScroll, true); } catch (e) {}

        const deadline = Date.now() + PARK_MAX_MS;
        // Re-arm the watchdog window whenever we have to act (so a late re-park
        // after a brief settle still keeps the port defended until PARK_MAX_MS
        // from the LAST real necessity, not from the first settle).
        let lastNecessary = Date.now();
        const rearm = () => { lastNecessary = Date.now(); };

        const hold = () => {
          if (detached() || Date.now() > deadline) { detach(); return; }
          try {
            if (port.scrollTop > 1) {
              releaseHostAnchor(port);
              try { glideOrSnap(port, top); } catch (e) {}
              rearm();
            } else if (Date.now() - lastNecessary > 500) {
              // Quiet at the top for ~500ms and nothing re-parked us: the host has
              // let go. Stop so a later downward scroll is never fought.
              detach();
              return;
            }
          } catch (e) {}
          setTimeout(hold, HOLD_TICK_MS);
        };
        setTimeout(hold, HOLD_TICK_MS);
      } catch (e) {}
    }

    /**
     * Animate the scrollport to a target offset, then hold it there.
     *
     * The lower-half handler asks the browser to smooth-scroll, so an upward
     * jump has to do the same or it looks like the feature is broken: the same
     * native primitive (scrollTo with behavior:'smooth') is used here, with the
     * instant writeScroll as the fallback for scrollports that cannot animate.
     *
     * The hold only starts once the animation settles (scrollend, or a timer for
     * browsers that lack it), and it is skipped entirely when the port ended up
     * somewhere the plugin did not send it: a reader gesture or the host's own
     * follow animation owns the scrollport at that point, and fighting it would
     * read as a jump tug-of-war.
     */
    function animateScroll(port, top) {
      try {
        if (!port) return;
        const max = Math.max(0, port.scrollHeight - port.clientHeight);
        const target = Math.min(Math.max(0, top), max);
        const reduced = typeof matchMedia === 'function' &&
          matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!reduced && typeof port.scrollTo === 'function') {
          const start = port.scrollTop;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            const current = port.scrollTop;
            // The smooth request was ignored outright: snap now instead of
            // leaving the jump undone.
            if (current === start) { writeScroll(port, target); return; }
            // The port moved, but not to where we sent it: someone else owns it.
            if (Math.abs(current - target) > 32) return;
            writeScroll(port, target);
          };
          // Walking to an earlier question in a long transcript is usually many
          // screens away. glideOrSnap writes those offsets directly, and in that
          // case there is no animation to wait for: the scrollend/timer bookkeeping
          // would only add host-visible scroll events for a jump already done.
          if (!glideOrSnap(port, target)) { writeScroll(port, target); return; }
          try { port.addEventListener('scrollend', release, { once: true }); } catch (e) {}
          try { setTimeout(release, 600); } catch (e) {}
          return;
        }
        writeScroll(port, target);
      } catch (e) {}
    }

    /**
     * Write a scroll offset, then re-assert it only while nobody else has moved
     * the scrollport.
     *
     * The host attributes an offset change to the reader (chat.js readScroll
     * 2148-2155 compares against its last acknowledged position), so a direct
     * write does not trigger its tail-follow snap-back — but a pending layout
     * change or a fold can still shift the row we just parked. Re-asserting is
     * therefore conditional: the moment the scrollport reports a position we
     * did not write, the reader owns it again and the re-asserts stop.
     */
    function writeScroll(port, top) {
      const max = Math.max(0, port.scrollHeight - port.clientHeight);
      const target = Math.min(Math.max(0, top), max);
      let held = -1;
      const apply = () => {
        try {
          if (port.scrollTop === target) return;
          // Someone else moved the port: stop fighting for it.
          if (held !== -1 && port.scrollTop !== held) return;
          port.scrollTop = target;
          held = port.scrollTop;
        } catch (e) {}
      };
      apply();
      try { requestAnimationFrame(apply); } catch (e) {}
      try { setTimeout(apply, 16); } catch (e) {}
      try { setTimeout(apply, 120); } catch (e) {}
      try { setTimeout(apply, 300); } catch (e) {}
    }

    function isInteractive(target) {
      try {
        if (!target) return false;
        const tag = (target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        if (target.isContentEditable) return true;
        // Only exact CODE or PRE elements block, not descendants inside messages.
        if (target.tagName && (target.tagName === 'CODE' || target.tagName === 'PRE')) return true;
        return false;
      } catch (e) { return false; }
    }

    function isLowerArea(target, container) {
      try {
        if (target && target.closest) {
          if (target.closest('[data-composer-seat]') || target.closest('[data-conversation-region="composer"]')) return true;
          if (target.closest('[data-composer-dock]')) return true;
        }
        return false;
      } catch (e) { return false; }
    }

    /**
     * Whether a click landed in the upper region of the scrollport (top 28%).
     * Only position matters here: the rapid-click gesture counts raw clicks, so
     * it cannot reuse handleContainer (which only runs on the second click of a
     * pair and would never see clicks 1, 3 and 5).
     */
    function isUpperArea(target, container, clientY) {
      try {
        if (isInteractive(target)) return false;
        if (isLoadEarlierControl(target, container)) return false;
        const rect = container.getBoundingClientRect();
        if (rect.height <= 0) return false;
        let y = clientY;
        if (typeof y !== 'number') {
          try { y = target.getBoundingClientRect().top + 4; }
          catch (e) { y = rect.top + rect.height; }
        }
        return (y - rect.top) / rect.height <= TOP_THRESHOLD;
      } catch (e) { return false; }
    }

    function handleContainer(container, event) {
      try {
        // While the aggressive "jump to the very front" gesture is still pulling
        // history and holding the park, no ordinary double-click should fight it.
        if (frontJumpInFlight) return;
        if (isInteractive(event.target)) return;
        // The host's own paged-history control owns its click; let it work.
        if (isLoadEarlierControl(event.target, container)) return;
        const rect = container.getBoundingClientRect();
        if (rect.height <= 0) return; // safety: nothing to measure
        let clientY = event.clientY;
        if (typeof clientY !== 'number') {
          try { clientY = event.target.getBoundingClientRect().top + 4; }
          catch (e) { clientY = rect.top + rect.height; }
        }
        const relative = (clientY - rect.top) / rect.height; // 0.0=top, 1.0=bottom
        const lowerByPosition = relative >= BOTTOM_THRESHOLD;
        const lowerByRegion = isLowerArea(event.target, container);

        // ---- lower area (bottom 28% or composer region) ----
        if (lowerByPosition || lowerByRegion) {
          event.preventDefault();
          event.stopPropagation();
          scrollToBottom(container);
          return;
        }
        // ---- upper area (top 28%) ----
        // The upper gesture is driven entirely by the click counter in
        // coverContainer, which defers the walk-up by a short grace so a rapid
        // triple-click merges into one continuous glide to the very top instead
        // of first jumping to the previous message. The native dblclick therefore
        // does nothing here; the counter decides.
        // ---- middle/other: do nothing (keep native selection etc) ----
      } catch (e) {}
    }

    return {
      inject: [],
      apply(ctx) {
        if (typeof document === 'undefined') return;

        // Attach listeners directly to scroll containers (window/document listeners don't fire).
        const covered = new WeakSet();
        function coverContainer(container) {
          if (!container || covered.has(container)) return;
          covered.add(container);
          const handler = (event) => { handleContainer(container, event); };
          try { container.addEventListener('dblclick', handler, true); } catch (e) {}
          // The upper-area gesture is driven entirely by raw upper clicks so the
          // double and the triple are disambiguated by timing instead of by
          // racing the native dblclick:
          //   - 2 upper clicks within DOUBLE_GRACE_MS => walk up ONE message
          //     (jumpToQuestion). It is deferred until the grace elapses, so a
          //     3rd click arriving in time SUPERSEDES it and jumps to the very
          //     top instead — i.e. a rapid triple is one continuous glide, not a
          //     walk-up followed by a jump.
          //   - 3 upper clicks within RAPID_CLICK_WINDOW => jump to the very top
          //     (jumpToFront) immediately, cancelling any pending walk-up.
          // The lower area still relies on the native dblclick (handleContainer),
          // with a manual double-tap fallback below for touch where dblclick is
          // unreliable.
          const upperStamps = []; // timestamps of upper-area clicks
          let upperTimer = null;  // grace timer for the deferred walk-up
          let upperWalkArmed = false; // a 2-click walk-up is pending
          // Manual double-tap fallback for the lower area (touch, no dblclick).
          const clickTimes = [];
          const clickHandler = (event) => {
            try {
              const now = Date.now();
              if (isUpperArea(event.target, container, event.clientY)) {
                // While the aggressive front jump is still pulling history, drop
                // further upper clicks so the park is not disturbed.
                if (frontJumpInFlight) return;
                upperStamps.push(now);
                while (upperStamps.length > RAPID_CLICK_COUNT + 2) upperStamps.shift();
                while (upperStamps.length > 0 && now - upperStamps[0] > RAPID_CLICK_WINDOW) upperStamps.shift();
                // Triple within the window: jump to the very top NOW, and
                // supersede any pending deferred walk-up.
                if (upperStamps.length >= RAPID_CLICK_COUNT) {
                  upperStamps.length = 0;
                  if (upperTimer) { clearTimeout(upperTimer); upperTimer = null; }
                  upperWalkArmed = false;
                  jumpToFront(container);
                  return;
                }
                // Two close upper clicks (a genuine double-tap) without a third
                // yet: arm the deferred walk-up. A 3rd click in time cancels it
                // (handled above). The gap must be within the grace, so two slow
                // separate clicks do not animate a walk-up.
                const n = upperStamps.length;
                if (n >= 2 && !upperWalkArmed && (now - upperStamps[n - 2]) <= DOUBLE_GRACE_MS) {
                  upperWalkArmed = true;
                  upperTimer = setTimeout(() => {
                    upperWalkArmed = false;
                    upperTimer = null;
                    upperStamps.length = 0;
                    if (!frontJumpInFlight) jumpToQuestion(container);
                  }, DOUBLE_GRACE_MS);
                }
                return;
              }
              // Lower / middle: manual double-tap detection (native dblclick may
              // be absent on touch). handleContainer routes it to scrollToBottom.
              clickTimes.push(now);
              while (clickTimes.length > 5) clickTimes.shift();
              const recent = clickTimes.filter((t) => now - t < 350);
              if (recent.length >= 2) {
                clickTimes.length = 0;
                handleContainer(container, event);
              }
            } catch (e) {}
          };
          try { container.addEventListener('click', clickHandler, true); } catch (e) {}
        }

        // Legacy selectors from older/alternative Harness builds. These exist
        // ONLY as a fallback: measured on a 150K-element transcript, one
        // document.querySelectorAll of the comma-joined union costs ~7.8ms while
        // the primary selector alone costs ~0.0ms — a multi-selector list loses
        // Blink's fast "nothing can match this" path and walks the whole tree for
        // each branch. And the current host renders none of these classes at all
        // (verified: they appear only inside CSS strings in the host bundle).
        // So the primary pass runs alone and the fallbacks only when it is empty.
        const FALLBACK_SELECTORS = [
          '.conversation-viewport',
          '.chat-view',
          '[data-chat-view]',
          '.conversation-scroll',
        ];

        function scan() {
          try {
            const ports = document.querySelectorAll(CONVERSATION_SELECTOR);
            if (ports.length) { ports.forEach(coverContainer); return; }
            for (const sel of FALLBACK_SELECTORS) {
              document.querySelectorAll(sel).forEach(coverContainer);
            }
          } catch (e) {}
        }

        // Classification helper: the primary port only. A build that uses a
        // legacy class makes this return null for its mutations, which reads as
        // "shell-level change" and schedules a full scan — the scan then finds
        // nothing under the primary selector and runs the fallbacks, so such a
        // build is still covered, one frame later.
        function portOf(node) {
          try { return node && node.closest ? node.closest(CONVERSATION_SELECTOR) : null; }
          catch (e) { return null; }
        }

        // Discovery of NEW scroll containers is what the observer is for. It must
        // never turn into a transcript-wide scan: the host renders a long
        // conversation as thousands of live elements (the flow list is not
        // virtualized) and streaming appends to them every frame. With
        // {childList,subtree} on documentElement, that used to re-enter this
        // callback many times per frame and each entry walked the whole document
        // five times over — the interface then locks up for seconds at a time.
        //
        // So each mutation batch is cheaply classified first:
        //  - an added element that IS a container -> cover it directly;
        //  - a change nested inside a known container -> reader content, ignore;
        //  - anything outside every container (app shell / conversation remount),
        //    or removals that detached themselves from the tree -> schedule a scan.
        // Batches that do need a scan are coalesced into one pass per animation
        // frame, and the 5s safety net below still catches anything the
        // classification deliberately lets slide.
        function needsScan(rec) {
          const added = rec.addedNodes;
          for (let i = 0; i < added.length; i++) {
            const n = added[i];
            if (!n || n.nodeType !== 1 || !n.closest) continue;
            const port = portOf(n);
            if (port === n) return 'cover'; // a brand-new scroll container
            if (!port) return true;         // shell-level mount: discover ports
          }
          const removed = rec.removedNodes;
          for (let i = 0; i < removed.length; i++) {
            const n = removed[i];
            if (!n || n.nodeType !== 1 || !n.closest) continue;
            if (!portOf(n)) return true; // container/subtree torn out
          }
          const target = rec.target;
          if (target && target.nodeType === 1 && target.closest) {
            if (!portOf(target)) return true;
          }
          return false;
        }

        let pending = false;   // a full scan is queued for the next frame
        let scanning = false;  // one pass at a time (never re-entrant)
        function guardedScan() {
          if (scanning || pending) return;
          pending = true;
          const run = () => {
            pending = false;
            if (scanning) return;
            scanning = true;
            try { scan(); } finally { scanning = false; }
          };
          try { requestAnimationFrame(run); } catch (e) { run(); }
        }
        function onMutations(records) {
          try {
            let structural = false;
            for (const rec of records) {
              const verdict = needsScan(rec);
              if (verdict === 'cover') {
                // Cover it now: waiting a frame for a container we can already see
                // would leave the gesture dead for that frame.
                const n = Array.prototype.find.call(rec.addedNodes, (x) => x && x.nodeType === 1 && portOf(x) === x);
                if (n) coverContainer(n);
              } else if (verdict === true) {
                structural = true;
              }
            }
            if (structural) guardedScan();
          } catch (e) {}
        }
        // First pass synchronous so a container that already exists is covered
        // before the user can interact with it; only later, mutation-driven
        // passes are coalesced into a frame.
        scan();
        const obs = new MutationObserver(onMutations);
        try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
        // Part B: the 1s poll is redundant now that the panel write is
        // idempotent. Keep a slow, cheap safety net instead of a hot loop:
        // containers removed and re-added without any other DOM change are
        // still caught, at 1/20th of the previous wake-up rate.
        const pollTimer = setInterval(guardedScan, 5000);

        return () => {
          try { obs.disconnect(); } catch (e) {}
          try { clearInterval(pollTimer); } catch (e) {}
        };
      },
    };
  },
});
