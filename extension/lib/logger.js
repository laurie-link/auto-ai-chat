const STORAGE_KEY = "debugLog";
const MAX_ENTRIES = 400;

/**
 * @param {object} entry
 */
export async function appendLog(entry) {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  const arr = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  arr.push(entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: arr.slice(-MAX_ENTRIES) });
}

export async function getLogs() {
  const data = await chrome.storage.local.get([STORAGE_KEY]);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

export async function clearLogs() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}
