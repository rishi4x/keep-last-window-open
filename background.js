const processing = new Map();
const debounceTimers = new Map();

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
    const unpinnedTabs = tabs.filter(t => !t.pinned);

    // Case 0: A pinned tab at index 0 is no longer a new tab (user navigated it) - unpin it
    const usedBuffer = tabs.find(t => t.pinned && t.index === 0 && !isNewTabPage(t));
    if (usedBuffer) {
      await chrome.tabs.update(usedBuffer.id, { pinned: false });
      // Reprocess after unpinning to handle buffer creation
      scheduleProcessWindow(windowId);
      return;
    }

    // Case 1: Only the buffer tab remains - unpin it and create new buffer
    if (tabs.length === 1 && bufferTab) {
      await chrome.tabs.update(bufferTab.id, { pinned: false });
      await chrome.tabs.create({
        windowId: windowId,
        url: "chrome://newtab",
        pinned: true,
        active: false,
        index: 0
      });
      return;
    }

    // Case 2: Only one unpinned tab and no buffer - create buffer
    if (unpinnedTabs.length === 1 && !bufferTab) {
      await chrome.tabs.create({
        windowId: windowId,
        url: "chrome://newtab",
        pinned: true,
        active: false,
        index: 0
      });
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
  if (removeInfo.isWindowClosing) {
    processing.delete(removeInfo.windowId);
    debounceTimers.delete(removeInfo.windowId);
    return;
  }
  scheduleProcessWindow(removeInfo.windowId);
});

chrome.tabs.onCreated.addListener((tab) => {
  // Don't trigger processing if we just created this tab (it's our buffer)
  if (!isBufferTab(tab)) {
    scheduleProcessWindow(tab.windowId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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
  if (window.type === "normal") {
    // Delay to let initial tab be created, then recheck all windows
    setTimeout(recheckAllWindows, 200);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  processing.delete(windowId);
  if (debounceTimers.has(windowId)) {
    clearTimeout(debounceTimers.get(windowId));
    debounceTimers.delete(windowId);
  }
  // Recheck remaining windows since count changed
  setTimeout(recheckAllWindows, 100);
});

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
