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

    function scrollToBottom(container) {
      try {
        if (!container) return;
        if (typeof container.scrollTo === 'function') {
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
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
        const flow = container.querySelector && container.querySelector('[data-chat-flow]');
        // enabledOnly=false: a disabled control still owns the click.
        const btn = findLoadEarlierButton(flow || container, container, false);
        return !!(btn && target.closest('button') === btn);
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
        // Searching the document keeps the walk-up above from narrowing the
        // search to a subtree that holds no user message; the scope test then
        // keeps only this conversation's own rows.
        const root = container.ownerDocument || document;
        const rows = [];
        // Two sets: `seenEl` skips a candidate element that is nested inside
        // another matching element, while `seenRows` dedupes the resolved turn
        // row. They must stay separate because the host puts data-chat-flow-kind
        // ("user") and data-chat-turn on the SAME flow-item element, so row === el
        // and a single shared set would drop every user message.
        const seenEl = new Set();
        const seenRows = new Set();
        // Membership: the row must live inside the same conversation subtree as
        // the container that was double-clicked. Scoping to the closest
        // [data-conversation-content] (the Conversation body that owns this
        // scrollport, conversation.js:17862-17877) rather than a bare
        // contains() keeps side-column copies out while still accepting the
        // main transcript when the two are siblings, not nested.
        const scope = conversationScope(container);
        for (const el of root.querySelectorAll(USER_TURN_SELECTOR)) {
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
          rows.push(row);
        }
        rows.sort((a, b) => {
          const ta = parseInt(a.getAttribute('data-chat-turn') || '0', 10);
          const tb = parseInt(b.getAttribute('data-chat-turn') || '0', 10);
          if (ta !== tb) return ta - tb;
          return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
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
          const r = row.getBoundingClientRect();
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
          port.scrollTo({ top: target, behavior: 'smooth' });
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

    function handleContainer(container, event) {
      try {
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
        const upperByPosition = relative <= TOP_THRESHOLD;

        // ---- lower area (bottom 28% or composer region) ----
        if (lowerByPosition || lowerByRegion) {
          event.preventDefault();
          event.stopPropagation();
          scrollToBottom(container);
          return;
        }
        // ---- upper area (top 28%) ----
        if (upperByPosition) {
          event.preventDefault();
          event.stopPropagation();
          jumpToQuestion(container);
          return;
        }
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
          // manual double-tap via click
          const clickTimes = [];
          const clickHandler = (event) => {
            try {
              const now = Date.now();
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

        function scan() {
          try {
            // Primary selector: data-conversation-scroll
            const primary = document.querySelectorAll(CONVERSATION_SELECTOR);
            // Fallback selectors commonly used in this Harness UI
            const fallbacks = [
              '.conversation-viewport',
              '.chat-view',
              '[data-chat-view]',
              '.conversation-scroll',
            ];
            const all = [...primary, ...fallbacks.map(s => document.querySelectorAll(s)).flat()].filter(
              (el, idx, arr) => arr.indexOf(el) === idx // dedupe
            );
            all.forEach(coverContainer);
          } catch (e) {}
        }
        // Re-entry guard: a scan triggered by our own mutations must not run
        // concurrently (and must not schedule another). One pass at a time.
        let scanning = false;
        function guardedScan() {
          if (scanning) return;
          scanning = true;
          try { scan(); } finally { scanning = false; }
        }
        guardedScan();
        const obs = new MutationObserver(guardedScan);
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
