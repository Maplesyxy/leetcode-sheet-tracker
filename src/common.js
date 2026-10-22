// Shared helpers (loaded by background via importScripts, by popup/options via <script>).
const DEFAULT_SETTINGS = {
  scriptUrl: '',     // Apps Script web-app URL (…/exec)
  sheetUrl: '',      // Google Sheet link, used for the "Open sheet" button
  idleMinutes: 10    // a session ends after this many minutes without activity on LeetCode
};

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(partial) {
  const next = { ...(await getSettings()), ...partial };
  await chrome.storage.sync.set({ settings: next });
  return next;
}

function fmtMinutes(mins) {
  mins = Math.max(0, Math.round(mins));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}

function fmtBadge(mins) {
  mins = Math.max(0, Math.floor(mins));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function round(n, d = 1) {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
}
