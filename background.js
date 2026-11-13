const processing = new Map();
const debounceTimers = new Map();

// --- Restored-buffer detection (keeps Cmd/Ctrl+Shift+T useful) ---
// Every buffer tab we close lands in Chrome's "recently closed" list, so
// Cmd/Ctrl+Shift+T would keep reopening an empty buffer. We detect when that
// happens and restore the next real closed tab/window instead.

// Ids of buffer tabs this extension created itself
const ownBufferTabs = new Set();
// Number of buffer creations in flight (onCreated can fire before create() resolves)
let pendingBufferCreates = 0;
// Creation time of tabs we didn't create, so a URL that arrives a moment
// after onCreated can still be checked
const recentTabs = new Map();
// Creation time of windows, so tabs inside a freshly restored window are ignored
const windowCreatedAt = new Map();
// Restored buffers we've already handled
const handledRestores = new Set();
let startupTime = 0;

const RECENT_TAB_MS = 3000;
const NEW_WINDOW_GRACE_MS = 2000;
const STARTUP_GRACE_MS = 5000;

async function createBufferTab(windowId) {
  pendingBufferCreates++;
  try {
    const tab = await chrome.tabs.create({
      windowId: windowId,
      url: "chrome://newtab",
      pinned: true,
      active: false,
      index: 0,
    });
    ownBufferTabs.add(tab.id);
  } finally {
    pendingBufferCreates--;
  }
}

function isRestoredBuffer(tab) {
  const now = Date.now();
  const createdAt = recentTabs.get(tab.id);
  const windowAge = now - (windowCreatedAt.get(tab.windowId) ?? 0);
  return (
    tab.pinned &&
    isNewTabPage(tab) &&
    !ownBufferTabs.has(tab.id) &&
    !handledRestores.has(tab.id) &&
    pendingBufferCreates === 0 &&
    createdAt !== undefined &&
    now - createdAt < RECENT_TAB_MS &&
    // Tabs in a window that was just opened/restored are real content, and
    // tabs restored at browser startup aren't from Cmd/Ctrl+Shift+T
    windowAge > NEW_WINDOW_GRACE_MS &&
    now - startupTime > STARTUP_GRACE_MS
  );
}

async function skipRestoredBuffer(tab) {
  handledRestores.add(tab.id);
  recentTabs.delete(tab.id);
  try {
    const entries = await chrome.sessions.getRecentlyClosed();
    const next = entries.find(
      (e) => e.window || (e.tab && !(e.tab.pinned && isNewTabPage(e.tab))),
    );
    if (next) {
      await chrome.sessions.restore(
        next.tab ? next.tab.sessionId : next.window.sessionId,
      );
    }
  } catch (e) {
    // Nothing restorable, ignore
  }
  // Let the normal logic decide whether the unwanted buffer should go
  scheduleProcessWindow(tab.windowId);
}

function checkForRestoredBuffer(tab) {
  if (isRestoredBuffer(tab)) {
    skipRestoredBuffer(tab);
    return true;
  }
  return false;
}

// Process window state with debouncing to avoid race conditions
function scheduleProcessWindow(windowId) {
  if (debounceTimers.has(windowId)) {
    clearTimeout(debounceTimers.get(windowId));
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(windowId);
    processWindow(windowId);
  }, 50);

  debounceTimers.set(windowId, timer);
}

function isNewTabPage(tab) {
  return (
    tab.url === "chrome://newtab/" ||
    tab.url === "chrome://newtab" ||
    tab.pendingUrl === "chrome://newtab/" ||
    tab.pendingUrl === "chrome://newtab"
  );
}

// Check if a tab is our buffer tab (pinned new tab at index 0)
function isBufferTab(tab) {
  return tab.pinned && tab.index === 0 && isNewTabPage(tab);
}

async function processWindow(windowId) {
  if (processing.get(windowId)) {
    scheduleProcessWindow(windowId);
    return;
  }

  processing.set(windowId, true);

  try {
    // Skip processing if this isn't a normal browser window (e.g., PWA/app windows)
    const window = await chrome.windows.get(windowId);
    if (window.type !== "normal") {
      return;
    }
    // Only apply buffer logic when there's exactly one window
    const allWindows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    if (allWindows.length > 1) {
      // Multiple windows exist - remove any buffer and skip
      const tabs = await chrome.tabs.query({ windowId: windowId });
      const bufferTab = tabs.find(isBufferTab);
      if (bufferTab) {
        await chrome.tabs.remove(bufferTab.id);
      }
      return;
    }

    const tabs = await chrome.tabs.query({ windowId: windowId });

    if (tabs.length === 0) {
      return;
    }

    const bufferTab = tabs.find(isBufferTab);
    const unpinnedTabs = tabs.filter((t) => !t.pinned);

    // Case 0: A pinned tab at index 0 is no longer a new tab (user navigated it) - unpin it
    const usedBuffer = tabs.find(
      (t) => t.pinned && t.index === 0 && !isNewTabPage(t),
    );
    if (usedBuffer) {
      await chrome.tabs.update(usedBuffer.id, { pinned: false });
      // Reprocess after unpinning to handle buffer creation
      scheduleProcessWindow(windowId);
      return;
    }

    // Case 1: Only the buffer tab remains - unpin it and create new buffer
    if (tabs.length === 1 && bufferTab) {
      await chrome.tabs.update(bufferTab.id, { pinned: false });
      await createBufferTab(windowId);
      return;
    }

    // Case 2: Only one unpinned tab and no buffer - create buffer
    if (unpinnedTabs.length === 1 && !bufferTab) {
      await createBufferTab(windowId);
      return;
    }

    // Case 3: Multiple unpinned tabs but a buffer exists - remove the buffer
    if (unpinnedTabs.length > 1 && bufferTab) {
      await chrome.tabs.remove(bufferTab.id);
      return;
    }
  } catch (e) {
    // Window might have been closed, ignore errors
  } finally {
    processing.set(windowId, false);
  }
}

async function initialize() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of windows) {
    scheduleProcessWindow(win.id);
  }
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  ownBufferTabs.delete(tabId);
  recentTabs.delete(tabId);
  handledRestores.delete(tabId);
  if (removeInfo.isWindowClosing) {
    processing.delete(removeInfo.windowId);
    debounceTimers.delete(removeInfo.windowId);
    return;
  }
  scheduleProcessWindow(removeInfo.windowId);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (pendingBufferCreates > 0 && tab.pinned && isNewTabPage(tab)) {
    // This is the buffer we're creating right now
    ownBufferTabs.add(tab.id);
    return;
  }

  if (!ownBufferTabs.has(tab.id)) {
    recentTabs.set(tab.id, Date.now());
    if (checkForRestoredBuffer(tab)) {
      return;
    }
  }

  // Don't trigger processing if we just created this tab (it's our buffer)
  if (!isBufferTab(tab)) {
    scheduleProcessWindow(tab.windowId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A restored tab's URL can arrive after onCreated
  if (
    (changeInfo.url !== undefined || changeInfo.pinned !== undefined) &&
    checkForRestoredBuffer(tab)
  ) {
    return;
  }
  if (changeInfo.pinned !== undefined || changeInfo.url !== undefined) {
    scheduleProcessWindow(tab.windowId);
  }
});

async function recheckAllWindows() {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of windows) {
    scheduleProcessWindow(win.id);
  }
}

chrome.windows.onCreated.addListener((window) => {
  windowCreatedAt.set(window.id, Date.now());
  if (window.type === "normal") {
    // Delay to let initial tab be created, then recheck all windows
    setTimeout(recheckAllWindows, 200);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  windowCreatedAt.delete(windowId);
  processing.delete(windowId);
  if (debounceTimers.has(windowId)) {
    clearTimeout(debounceTimers.get(windowId));
    debounceTimers.delete(windowId);
  }
  // Recheck remaining windows since count changed
  setTimeout(recheckAllWindows, 100);
});

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(() => {
  startupTime = Date.now();
  initialize();
});
