"use strict";

const STORAGE_KEY = "browserSessions";

/**
 * Returns whether a saved URL can be restored by this extension.
 *
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isRestorableUrl(url) {
  if (!url) {
    return false;
  }

  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Retrieves one saved session by ID.
 *
 * @param {string} sessionId
 * @returns {Promise<Object | null>}
 */
async function getSessionById(sessionId) {
  const result = await chrome.storage.local.get({
    [STORAGE_KEY]: []
  });

  const sessions = Array.isArray(result[STORAGE_KEY])
    ? result[STORAGE_KEY]
    : [];

  return (
    sessions.find((session) => session.id === sessionId) ??
    null
  );
}

/**
 * Normalizes saved tabs.
 *
 * This also preserves compatibility with sessions created by V0.1,
 * which did not store index or active state.
 *
 * @param {Array} tabs
 * @returns {Array}
 */
function normalizeSavedTabs(tabs) {
  if (!Array.isArray(tabs)) {
    return [];
  }

  return tabs
    .map((tab, arrayIndex) => ({
      title: tab.title || tab.url || "Untitled",
      url: tab.url,
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),

      // Old V0.1 sessions did not contain index.
      index: Number.isInteger(tab.index)
        ? tab.index
        : arrayIndex
    }))
    .filter((tab) => isRestorableUrl(tab.url))
    .sort((first, second) => first.index - second.index);
}

/**
 * Restores a session into a new Chrome window.
 *
 * Restoration happens in four stages:
 * 1. Create all tabs.
 * 2. Restore pinned state.
 * 3. Restore tab ordering.
 * 4. Restore the previously active tab.
 *
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function restoreSession(sessionId) {
  const session = await getSessionById(sessionId);

  if (!session) {
    throw new Error("The requested session does not exist.");
  }

  const savedTabs = normalizeSavedTabs(session.tabs);

  if (savedTabs.length === 0) {
    throw new Error(
      "The session does not contain any restorable tabs."
    );
  }

  /*
   * Create the complete window in one operation.
   *
   * This gives us a stable set of tabs before changing pinned state
   * or ordering.
   */
  const createdWindow = await chrome.windows.create({
    url: savedTabs.map((tab) => tab.url),
    focused: true
  });

  if (!createdWindow?.id) {
    throw new Error("Chrome failed to create the new window.");
  }

  const createdTabs = await chrome.tabs.query({
    windowId: createdWindow.id
  });

  createdTabs.sort(
    (first, second) => first.index - second.index
  );

  /*
   * Associate each saved tab with the corresponding newly created tab
   * before pinning or moving anything.
   *
   * Tab IDs remain stable even when Chrome rearranges the tab strip.
   */
  const tabMappings = savedTabs
    .map((savedTab, arrayIndex) => ({
      savedTab,
      createdTabId: createdTabs[arrayIndex]?.id
    }))
    .filter(
      (mapping) =>
        typeof mapping.createdTabId === "number"
    );

  if (tabMappings.length !== savedTabs.length) {
    throw new Error(
      "Chrome did not create the expected number of tabs."
    );
  }

  /*
   * Restore pinned tabs.
   */
  for (const mapping of tabMappings) {
    if (!mapping.savedTab.pinned) {
      continue;
    }

    await chrome.tabs.update(mapping.createdTabId, {
      pinned: true
    });
  }

  /*
   * Restore exact ordering.
   *
   * Using saved tab IDs prevents pinning operations from breaking
   * our association between old and new tabs.
   */
  const mappingsByIndex = [...tabMappings].sort(
    (first, second) =>
      first.savedTab.index - second.savedTab.index
  );

  for (const mapping of mappingsByIndex) {
    await chrome.tabs.move(mapping.createdTabId, {
      index: mapping.savedTab.index
    });
  }

  /*
   * Restore the active tab.
   *
   * Older sessions may not have an active flag, so fall back to
   * the first tab.
   */
  const activeMapping =
    tabMappings.find(
      (mapping) => mapping.savedTab.active
    ) ??
    tabMappings[0];

  await chrome.tabs.update(
    activeMapping.createdTabId,
    {
      active: true
    }
  );

  await chrome.windows.update(createdWindow.id, {
    focused: true
  });
}

/**
 * Handles messages from extension UI components.
 *
 * We deliberately use sendResponse + return true instead of relying
 * on Promise-returning message listeners so this remains compatible
 * across Chrome versions.
 */
function handleMessage(message, _sender, sendResponse) {
  if (message?.type !== "RESTORE_SESSION") {
    return undefined;
  }

  restoreSession(message.sessionId)
    .then(() => {
      sendResponse({
        ok: true
      });
    })
    .catch((error) => {
      console.error(
        "Failed to restore browser session:",
        error
      );

      sendResponse({
        ok: false,
        error: error.message
      });
    });

  // Keep the message channel alive while restoreSession() runs.
  return true;
}

chrome.runtime.onMessage.addListener(handleMessage);