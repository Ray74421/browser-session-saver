"use strict";

const STORAGE_KEY = "browserSessions";

const sessionNameInput = document.querySelector("#session-name");
const saveSessionButton = document.querySelector("#save-session");
const sessionsList = document.querySelector("#sessions-list");
const statusMessage = document.querySelector("#status-message");

/**
 * Returns whether a URL can safely be restored by this extension.
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
 * Reads all saved sessions from extension storage.
 *
 * @returns {Promise<Array>}
 */
async function getSessions() {
  const result = await chrome.storage.local.get({
    [STORAGE_KEY]: []
  });

  return Array.isArray(result[STORAGE_KEY])
    ? result[STORAGE_KEY]
    : [];
}

/**
 * Replaces all saved sessions in extension storage.
 *
 * @param {Array} sessions
 * @returns {Promise<void>}
 */
async function setSessions(sessions) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: sessions
  });
}

/**
 * Shows a short status message inside the popup.
 *
 * @param {string} message
 */
function showStatus(message) {
  statusMessage.textContent = message;
}

/**
 * Formats an ISO timestamp.
 *
 * @param {string | undefined} isoTimestamp
 * @returns {string}
 */
function formatDate(isoTimestamp) {
  if (!isoTimestamp) {
    return "";
  }

  const date = new Date(isoTimestamp);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString();
}

/**
 * Returns a short hostname suitable for session inspection.
 *
 * @param {string} url
 * @returns {string}
 */
function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Captures the current browser window as serializable tab state.
 *
 * @returns {Promise<Array>}
 */
async function captureCurrentWindowTabs() {
  const tabs = await chrome.tabs.query({
    currentWindow: true
  });

  return tabs
    .filter((tab) => isRestorableUrl(tab.url))
    .map((tab) => ({
      title: tab.title || tab.url,
      url: tab.url,
      index: tab.index,
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active)
    }));
}

/**
 * Saves the current browser window as a brand-new session.
 */
async function saveCurrentSession() {
  const sessionName = sessionNameInput.value.trim();

  if (!sessionName) {
    showStatus("Enter a session name first.");
    sessionNameInput.focus();
    return;
  }

  try {
    saveSessionButton.disabled = true;

    const savedTabs = await captureCurrentWindowTabs();

    if (savedTabs.length === 0) {
      showStatus("No restorable web tabs found.");
      return;
    }

    const sessions = await getSessions();

    const timestamp = new Date().toISOString();

    sessions.unshift({
      id: crypto.randomUUID(),
      name: sessionName,
      createdAt: timestamp,
      updatedAt: timestamp,
      tabs: savedTabs
    });

    await setSessions(sessions);

    sessionNameInput.value = "";

    showStatus(
      `Saved "${sessionName}" with ${savedTabs.length} tabs.`
    );

    await renderSessions();
  } catch (error) {
    console.error("Failed to save session:", error);
    showStatus("Failed to save the current session.");
  } finally {
    saveSessionButton.disabled = false;
  }
}

/**
 * Replaces a saved session's tab state with the current Chrome window.
 *
 * The session keeps its ID, name, and original creation timestamp.
 *
 * @param {string} sessionId
 */
async function updateSession(sessionId) {
  try {
    const currentTabs = await captureCurrentWindowTabs();

    if (currentTabs.length === 0) {
      showStatus("No restorable web tabs found.");
      return;
    }

    const sessions = await getSessions();

    const sessionIndex = sessions.findIndex(
      (session) => session.id === sessionId
    );

    if (sessionIndex === -1) {
      showStatus("Session could not be found.");
      return;
    }

    const existingSession = sessions[sessionIndex];

    sessions[sessionIndex] = {
      ...existingSession,
      tabs: currentTabs,
      updatedAt: new Date().toISOString()
    };

    await setSessions(sessions);

    showStatus(
      `Updated "${existingSession.name}" with ${currentTabs.length} tabs.`
    );

    await renderSessions();
  } catch (error) {
    console.error("Failed to update session:", error);
    showStatus("Failed to update this session.");
  }
}

/**
 * Renames an existing saved session.
 *
 * @param {string} sessionId
 */
async function renameSession(sessionId) {
  try {
    const sessions = await getSessions();

    const session = sessions.find(
      (candidate) => candidate.id === sessionId
    );

    if (!session) {
      showStatus("Session could not be found.");
      return;
    }

    const newName = window.prompt(
      "Rename session:",
      session.name
    );

    // The user clicked Cancel.
    if (newName === null) {
      return;
    }

    const trimmedName = newName.trim();

    if (!trimmedName) {
      showStatus("Session name cannot be empty.");
      return;
    }

    session.name = trimmedName;
    session.updatedAt = new Date().toISOString();

    await setSessions(sessions);

    showStatus(`Renamed session to "${trimmedName}".`);

    await renderSessions();
  } catch (error) {
    console.error("Failed to rename session:", error);
    showStatus("Failed to rename this session.");
  }
}

/**
 * Opens one saved URL in a new active tab in the current window.
 *
 * @param {string} url
 */
async function openIndividualTab(url) {
  if (!isRestorableUrl(url)) {
    showStatus("This tab URL cannot be opened.");
    return;
  }

  try {
    await chrome.tabs.create({
      url,
      active: true
    });
  } catch (error) {
    console.error("Failed to open tab:", error);
    showStatus("Failed to open this tab.");
  }
}

/**
 * Requests full-session restoration from the background worker.
 *
 * @param {string} sessionId
 */
async function restoreSession(sessionId) {
  try {
    showStatus("Restoring session...");

    const response = await chrome.runtime.sendMessage({
      type: "RESTORE_SESSION",
      sessionId
    });

    if (!response?.ok) {
      throw new Error(
        response?.error ||
        "The background worker could not restore the session."
      );
    }
  } catch (error) {
    console.error("Failed to restore session:", error);

    showStatus(
      error.message ||
      "Failed to restore this session."
    );
  }
}

/**
 * Deletes one saved session.
 *
 * @param {string} sessionId
 */
async function deleteSession(sessionId) {
  try {
    const sessions = await getSessions();

    const session = sessions.find(
      (candidate) => candidate.id === sessionId
    );

    if (!session) {
      showStatus("Session could not be found.");
      return;
    }

    const confirmed = window.confirm(
      `Delete "${session.name}"?`
    );

    if (!confirmed) {
      return;
    }

    const updatedSessions = sessions.filter(
      (candidate) => candidate.id !== sessionId
    );

    await setSessions(updatedSessions);

    showStatus(`Deleted "${session.name}".`);

    await renderSessions();
  } catch (error) {
    console.error("Failed to delete session:", error);
    showStatus("Failed to delete this session.");
  }
}

/**
 * Creates a small badge.
 *
 * @param {string} text
 * @returns {HTMLElement}
 */
function createBadge(text) {
  const badge = document.createElement("span");

  badge.className = "tab-badge";
  badge.textContent = text;

  return badge;
}

/**
 * Creates one saved-tab row.
 *
 * @param {Object} tab
 * @returns {HTMLElement}
 */
function createTabRow(tab) {
  const item = document.createElement("li");
  item.className = "saved-tab";

  const content = document.createElement("div");
  content.className = "saved-tab-content";

  const header = document.createElement("div");
  header.className = "saved-tab-header";

  const title = document.createElement("span");
  title.className = "saved-tab-title";
  title.textContent = tab.title || "Untitled";
  title.title = tab.title || tab.url || "";

  const badges = document.createElement("span");
  badges.className = "saved-tab-badges";

  if (tab.pinned) {
    badges.appendChild(
      createBadge("Pinned")
    );
  }

  if (tab.active) {
    badges.appendChild(
      createBadge("Active")
    );
  }

  header.append(
    title,
    badges
  );

  const hostname = document.createElement("div");
  hostname.className = "saved-tab-host";
  hostname.textContent = getHostname(tab.url);

  content.append(
    header,
    hostname
  );

  const openButton = document.createElement("button");

  openButton.type = "button";
  openButton.className = "open-tab-button";
  openButton.textContent = "Open";

  openButton.addEventListener("click", async (event) => {
    /*
     * Prevent the click from toggling the surrounding <details>
     * element.
     */
    event.stopPropagation();

    await openIndividualTab(tab.url);
  });

  item.append(
    content,
    openButton
  );

  return item;
}

/**
 * Creates the expandable list of tabs inside one session.
 *
 * @param {Object} session
 * @returns {HTMLElement}
 */
function createTabsDetails(session) {
  const details = document.createElement("details");
  details.className = "session-details";

  const summary = document.createElement("summary");

  const tabCount = Array.isArray(session.tabs)
    ? session.tabs.length
    : 0;

  summary.textContent = `View ${tabCount} tabs`;

  const list = document.createElement("ol");
  list.className = "saved-tabs-list";

  const sortedTabs = Array.isArray(session.tabs)
    ? [...session.tabs].sort(
        (first, second) =>
          (first.index ?? 0) -
          (second.index ?? 0)
      )
    : [];

  for (const tab of sortedTabs) {
    list.appendChild(
      createTabRow(tab)
    );
  }

  details.append(
    summary,
    list
  );

  return details;
}

/**
 * Creates one session action button.
 *
 * @param {string} text
 * @param {() => Promise<void>} handler
 * @param {string} [className]
 * @returns {HTMLButtonElement}
 */
function createActionButton(
  text,
  handler,
  className = ""
) {
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = text;

  if (className) {
    button.classList.add(className);
  }

  button.addEventListener("click", handler);

  return button;
}

/**
 * Creates one saved-session card.
 *
 * @param {Object} session
 * @returns {HTMLElement}
 */
function createSessionCard(session) {
  const card = document.createElement("article");
  card.className = "session-card";

  const name = document.createElement("p");
  name.className = "session-name";
  name.textContent = session.name;

  const metadata = document.createElement("p");
  metadata.className = "session-meta";

  const tabs = Array.isArray(session.tabs)
    ? session.tabs
    : [];

  const pinnedCount = tabs.filter(
    (tab) => tab.pinned
  ).length;

  /*
   * Older sessions from V0.1/V0.2 do not contain updatedAt.
   */
  const latestTimestamp =
    session.updatedAt ??
    session.createdAt;

  metadata.textContent =
    `${tabs.length} tabs` +
    (pinnedCount > 0
      ? ` · ${pinnedCount} pinned`
      : "") +
    ` · Updated ${formatDate(latestTimestamp)}`;

  const details = createTabsDetails(session);

  const actions = document.createElement("div");
  actions.className = "session-actions";

  const restoreButton = createActionButton(
    "Restore",
    async () => {
      await restoreSession(session.id);
    },
    "primary-action"
  );

  const updateButton = createActionButton(
    "Update",
    async () => {
      await updateSession(session.id);
    }
  );

  const renameButton = createActionButton(
    "Rename",
    async () => {
      await renameSession(session.id);
    }
  );

  const deleteButton = createActionButton(
    "Delete",
    async () => {
      await deleteSession(session.id);
    },
    "danger-action"
  );

  actions.append(
    restoreButton,
    updateButton,
    renameButton,
    deleteButton
  );

  card.append(
    name,
    metadata,
    details,
    actions
  );

  return card;
}

/**
 * Renders all currently saved sessions.
 */
async function renderSessions() {
  try {
    const sessions = await getSessions();

    sessionsList.replaceChildren();

    if (sessions.length === 0) {
      const emptyState =
        document.createElement("p");

      emptyState.className = "empty-state";
      emptyState.textContent =
        "No saved sessions yet.";

      sessionsList.appendChild(emptyState);

      return;
    }

    for (const session of sessions) {
      sessionsList.appendChild(
        createSessionCard(session)
      );
    }
  } catch (error) {
    console.error(
      "Failed to render sessions:",
      error
    );

    showStatus("Failed to load saved sessions.");
  }
}

saveSessionButton.addEventListener(
  "click",
  saveCurrentSession
);

sessionNameInput.addEventListener(
  "keydown",
  async (event) => {
    if (event.key !== "Enter") {
      return;
    }

    await saveCurrentSession();
  }
);

renderSessions();