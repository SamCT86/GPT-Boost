import { getMessage } from './i18n';

(() => {
  const DEBUG = false;
  const log = (...args) => {
    try {
      if (DEBUG) console.log('[GPT Boost]', ...args);
    } catch (_) {
      // ignore: extension context may be invalidated
    }
  };

  const DEFAULTS = Object.freeze({
    maxVisible: 10,
    batchSize: 10,
    autoloadOnScroll: true,
    hideOldestOnNew: true,
    deleteMessages: false,
    hiddenDomBuffer: 0,
    userMessageMaxHeight: 200,
  });

  let settings = { ...DEFAULTS };

  const state = {
    firstVisible: 0, // index of first visible message (0 = show all)
    prunedCount: 0, // messages permanently removed (delete mode)
  };

  // DOM references
  let container = null;
  let messages = [];
  let placeholder = null;
  let placeholderObserver = null;
  let uiBar = null;
  let resetLimit = false;

  // ─────────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────────
  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (res) => {
          settings = { ...DEFAULTS, ...res };
          log('loadSettings:', settings);
          resolve(settings);
        });
      } catch (e) {
        settings = { ...DEFAULTS };
        resolve(settings);
      }
    });
  }

  function watchSettings() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        const changedKeys = Object.keys(DEFAULTS).filter((key) => key in changes);
        if (!changedKeys.length) return;
        for (const key of changedKeys) settings[key] = changes[key].newValue ?? DEFAULTS[key];
        resetLimit ||= changedKeys.includes('maxVisible');
        scheduleApply('settings changed');
      });
    } catch (_) {
      // ignore: chrome.storage may not be available
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Selectors
  // ─────────────────────────────────────────────────────────────────
  const MESSAGE_SELECTOR = [
    '[data-testid^="conversation-turn"]',
    '[data-content-search-unit-key$=":user"]',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-turn="user"]',
    '[data-turn="assistant"]',
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    'div[data-message-id]',
    'div[data-testid="message"]',
  ].join(',');
  const USER_BUBBLE_SELECTOR = '[data-user-message-bubble], [data-message-author-role="user"]';
  const HIDDEN_CLASS = 'gpt-boost-turn-hidden';
  const measuredHeights = new WeakMap();
  const heightNodes = new Set();
  const prunedNodes = new WeakSet();

  function findContainer() {
    return document.querySelector('main, [role="main"]');
  }

  function collectMessages() {
    return [...container.querySelectorAll(MESSAGE_SELECTOR)].filter((node) => {
      const ancestor = node.parentElement?.closest(MESSAGE_SELECTOR);
      return !ancestor || !container.contains(ancestor);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Hide and restore only styles owned by this extension
  // ─────────────────────────────────────────────────────────────────
  function setHidden(node, hidden) {
    if (node.classList.contains(HIDDEN_CLASS) !== hidden) node.classList.toggle(HIDDEN_CLASS, hidden);
  }

  // ─────────────────────────────────────────────────────────────────
  // Message Height Limiting
  // ─────────────────────────────────────────────────────────────────
  function applyHeightLimits() {
    const limit = Math.max(1, settings.userMessageMaxHeight);
    const measured = [];
    for (let index = state.firstVisible; index < messages.length; index++) {
      const message = messages[index];
      const bubble = message.matches(USER_BUBBLE_SELECTOR) ? message : message.querySelector(USER_BUBBLE_SELECTOR);
      if (!bubble || measuredHeights.get(bubble) === limit || !bubble.getClientRects().length) continue;
      measured.push({ bubble, collapse: bubble.scrollHeight > limit });
    }
    for (const { bubble, collapse } of measured) {
      measuredHeights.set(bubble, limit);
      if (collapse) {
        heightNodes.add(bubble);
        bubble.style.setProperty('--gpt-boost-message-max-height', limit + 'px');
        if (!bubble.classList.contains('gpt-boost-expanded')) bubble.classList.add('gpt-boost-collapsed');
      } else {
        clearHeightLimit(bubble);
      }
    }
  }

  function clearHeightLimit(node) {
    if (!heightNodes.delete(node)) return;
    node.classList.remove('gpt-boost-collapsed', 'gpt-boost-expanded');
    node.style.removeProperty('--gpt-boost-message-max-height');
  }

  function onMessageClick(event) {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest('a, button, input, textarea, [contenteditable="true"]') ||
      window.getSelection()?.toString()
    )
      return;
    const bubble = target.closest('.gpt-boost-collapsed, .gpt-boost-expanded');
    if (!bubble || !heightNodes.has(bubble)) return;
    const expand = bubble.classList.contains('gpt-boost-collapsed');
    bubble.classList.toggle('gpt-boost-collapsed', !expand);
    bubble.classList.toggle('gpt-boost-expanded', expand);
  }

  // ─────────────────────────────────────────────────────────────────
  // Placeholder
  // ─────────────────────────────────────────────────────────────────
  function clearPlaceholder() {
    placeholderObserver?.disconnect();
    placeholderObserver = null;
    placeholder?.remove();
    placeholder = null;
  }

  function renderPlaceholder() {
    const hiddenCount = state.firstVisible;
    const anchor = messages[hiddenCount];
    if (!hiddenCount || !anchor?.isConnected || settings.deleteMessages) {
      clearPlaceholder();
      return;
    }
    if (!placeholder) {
      placeholder = document.createElement('button');
      placeholder.type = 'button';
      placeholder.className = 'gpt-boost-hidden-placeholder';
      placeholder.isGptBoost = true;
      placeholder.addEventListener('click', revealOlder);
    }
    const label =
      hiddenCount === 1
        ? getMessage('hiddenPlaceholderSingular', [String(settings.batchSize)])
        : getMessage('hiddenPlaceholderPlural', [String(hiddenCount), String(settings.batchSize)]);
    if (placeholder.textContent !== label) placeholder.textContent = label;
    if (anchor.previousSibling !== placeholder) anchor.before(placeholder);
    if (settings.autoloadOnScroll && !placeholderObserver) {
      placeholderObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.target === placeholder)) revealOlder();
      });
      placeholderObserver.observe(placeholder);
    } else if (!settings.autoloadOnScroll && placeholderObserver) {
      placeholderObserver.disconnect();
      placeholderObserver = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // UI Bar
  // ─────────────────────────────────────────────────────────────────
  function ensureUI() {
    if (!uiBar) {
      uiBar = document.createElement('div');
      uiBar.isGptBoost = true;
      uiBar.className = 'gpt-boost-bar';
      const pill = document.createElement('div');
      pill.className = 'gpt-boost-pill';
      pill.isGptBoost = true;
      pill.innerHTML = `
        <span id="gpt-boost-status">${getMessage('statusActive')}</span>
        <button id="gpt-boost-show-older" title="${getMessage('showOlderTitle')}">${getMessage('showOlder')}</button>
        <button id="gpt-boost-collapse" title="${getMessage('collapseTitle')}">${getMessage('collapse')}</button>
        <button id="gpt-boost-reload" title="${getMessage('reloadPageTitle')}" style="display:none;">${getMessage('reloadPage')}</button>
        <span class="gpt-boost-drag-handle" title="${getMessage('dragTitle')}">
          <span class="gpt-boost-drag-dot"></span><span class="gpt-boost-drag-dot"></span><span class="gpt-boost-drag-dot"></span>
          <span class="gpt-boost-drag-dot"></span><span class="gpt-boost-drag-dot"></span><span class="gpt-boost-drag-dot"></span>
        </span>
      `;
      uiBar.appendChild(pill);
      document.body.appendChild(uiBar);

      pill.querySelector('#gpt-boost-show-older').addEventListener('click', revealOlder);
      pill.querySelector('#gpt-boost-collapse').addEventListener('click', collapseToThreshold);
      pill.querySelector('#gpt-boost-reload').addEventListener('click', () => location.reload());
      setupDrag(pill);
    } else if (!uiBar.isConnected) {
      document.body.appendChild(uiBar);
    }
  }

  function setupDrag(pill) {
    const handle = pill.querySelector('.gpt-boost-drag-handle');
    if (!handle || pill.dataset.dragInit) return;
    pill.dataset.dragInit = '1';

    let dragging = false,
      offsetX = 0,
      offsetY = 0;
    const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

    const move = (cx, cy) => {
      const rect = pill.getBoundingClientRect();
      pill.style.left = `${clamp(cx - offsetX, 4, innerWidth - rect.width - 4)}px`;
      pill.style.top = `${clamp(cy - offsetY, 4, innerHeight - rect.height - 4)}px`;
    };

    const onMove = (e) => dragging && (e.preventDefault(), move(e.clientX, e.clientY));
    const onTouchMove = (e) =>
      dragging && e.touches[0] && (e.preventDefault(), move(e.touches[0].clientX, e.touches[0].clientY));
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', endDrag);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', endDrag);
      handle.classList.remove('dragging');
    };

    const begin = (cx, cy) => {
      const rect = pill.getBoundingClientRect();
      pill.style.transform = 'none';
      pill.style.left = `${rect.left}px`;
      pill.style.top = `${rect.top}px`;
      offsetX = cx - rect.left;
      offsetY = cy - rect.top;
      dragging = true;
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', endDrag);
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend', endDrag);
    };

    handle.addEventListener('mousedown', (e) => (e.preventDefault(), begin(e.clientX, e.clientY)));
    handle.addEventListener(
      'touchstart',
      (e) => e.touches[0] && (e.preventDefault(), begin(e.touches[0].clientX, e.touches[0].clientY)),
      { passive: false }
    );
  }

  function updateStatus(total, visible) {
    const el = uiBar?.querySelector('#gpt-boost-status');
    if (!el) return;
    const label = settings.deleteMessages
      ? getMessage('statusBarDeleteMode', [
          String(visible),
          String(state.firstVisible),
          String(total + state.prunedCount),
        ])
      : getMessage('statusBar', [String(visible), String(total)]);
    if (el.textContent !== label) el.textContent = label;
  }

  function syncUIState() {
    const showBtn = uiBar.querySelector('#gpt-boost-show-older');
    const reloadBtn = uiBar.querySelector('#gpt-boost-reload');
    showBtn.disabled = state.firstVisible === 0;
    reloadBtn.style.display = state.prunedCount > 0 ? 'block' : 'none';
  }

  // ─────────────────────────────────────────────────────────────────
  // Core windowing
  // ─────────────────────────────────────────────────────────────────
  function applyWindowing() {
    handleRouteChange();
    if (!lastPath) return;
    const nextContainer = findContainer();
    if (nextContainer !== container) {
      resetWindow();
      container = nextContainer;
    }
    if (!container) return;

    const previous = messages;
    messages = collectMessages();
    if (!messages.length) {
      resetWindow();
      return;
    }
    ensureUI();
    const retainedFirst = messages.indexOf(previous[state.firstVisible]);
    const sameThread = retainedFirst >= 0 || messages.includes(previous.at(-1));
    const limit = thresholdIndex();
    if (!sameThread) {
      state.prunedCount = 0;
    }
    const appended = messages.length > previous.length && messages.at(-1) !== previous.at(-1);
    state.firstVisible =
      resetLimit || !sameThread || (settings.hideOldestOnNew && appended)
        ? limit
        : Math.min(retainedFirst >= 0 ? retainedFirst : state.firstVisible, limit);
    resetLimit = false;
    renderWindow();
  }

  function renderWindow() {
    if (settings.deleteMessages) {
      const count = Math.max(0, state.firstVisible - Math.max(0, settings.hiddenDomBuffer));
      const removed = messages.splice(0, count);
      for (const node of removed) {
        prunedNodes.add(node);
        node.remove();
      }
      state.prunedCount += removed.length;
      state.firstVisible -= removed.length;
    }
    messages.forEach((node, index) => setHidden(node, index < state.firstVisible));
    for (const node of heightNodes) {
      if (!container.contains(node)) clearHeightLimit(node);
    }
    refreshWindowControls();
  }

  function refreshWindowControls() {
    applyHeightLimits();
    renderPlaceholder();
    updateStatus(messages.length, messages.length - state.firstVisible);
    syncUIState();
  }

  function revealOlder() {
    if (!state.firstVisible || !messages[state.firstVisible]?.isConnected) return;
    const newFirst = Math.max(0, state.firstVisible - Math.max(1, settings.batchSize));
    for (let i = newFirst; i < state.firstVisible; i++) {
      setHidden(messages[i], false);
    }
    state.firstVisible = newFirst;
    refreshWindowControls();
  }

  function collapseToThreshold() {
    if (!messages.length) return;
    state.firstVisible = thresholdIndex();
    renderWindow();
    messages.at(-1)?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function thresholdIndex() {
    return Math.max(0, messages.length - Math.max(1, settings.maxVisible));
  }

  function resetWindow() {
    for (const message of messages) setHidden(message, false);
    for (const bubble of heightNodes) {
      clearHeightLimit(bubble);
      measuredHeights.delete(bubble);
    }
    messages = [];
    state.firstVisible = 0;
    state.prunedCount = 0;
    clearPlaceholder();
    uiBar?.remove();
  }

  // ─────────────────────────────────────────────────────────────────
  // Scheduling & Observation
  // ─────────────────────────────────────────────────────────────────
  let scheduled = false;
  function scheduleApply(reason) {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      log('scheduleApply:', reason);
      applyWindowing();
    });
  }

  function setupObserver() {
    const structureSelector = MESSAGE_SELECTOR + ',main,[role="main"]';
    const hostsThread = (node) =>
      node instanceof Element &&
      !node.isGptBoost &&
      (node.matches(structureSelector) || Boolean(node.querySelector(structureSelector)));
    const observer = new MutationObserver((records) => {
      if (handleRouteChange()) {
        scheduleApply('route change');
        return;
      }
      if (!lastPath) return;
      const changed = records.some((record) => {
        const target = record.target;
        if (!(target instanceof Element) || target.isGptBoost || target.closest(MESSAGE_SELECTOR)) return false;
        return (
          [...record.addedNodes].some(hostsThread) ||
          [...record.removedNodes].some((node) => !prunedNodes.delete(node) && hostsThread(node))
        );
      });
      if (changed) scheduleApply('message structure changed');
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  let lastPath = '';
  function handleRouteChange() {
    const path = location.pathname.match(/\/(?:share|c)\/[^/]+(?=\/?$)/)?.[0] ?? '';
    if (path === lastPath) return false;
    lastPath = path;
    resetWindow();
    container = null;
    return true;
  }

  // ─────────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────────
  async function init() {
    await loadSettings();
    watchSettings();
    setupObserver();
    document.addEventListener('click', onMessageClick);
    scheduleApply('init');
    const onNavigation = () => {
      if (handleRouteChange()) scheduleApply('route change');
    };
    window.navigation?.addEventListener('currententrychange', onNavigation);
    window.addEventListener('popstate', onNavigation);
    window.addEventListener('pageshow', onNavigation);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
