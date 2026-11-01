/**
 * youDl background script.
 * Chrome/Edge/Brave: MV3 service worker.
 * Firefox: MV3 event page (same file works — all APIs used here are stable).
 *
 * Responsibilities:
 *   - track the active tab's video URL reported by the sniffer content script
 *   - badge the action icon when a downloadable video is open
 *   - proxy the helper API for content scripts (YouTube's CSP blocks direct
 *     localhost fetches from the page, so the overlay routes through here)
 *   - OWN the job lifecycle: any download started from the pill or the popup
 *     is registered here, polled once per second, cached and persisted, so
 *     page-local UI (overlay, popup) can re-render true state at any time
 */
'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;
const action = api.action || api.browserAction;

const API_BASE = 'http://127.0.0.1:8765';
const nativeDownloadJobs = new Map();
const nativeDownloadStorageKey = 'ydlNativeDownloadJobs';

if (api.downloads && api.downloads.onChanged) {
  api.downloads.onChanged.addListener((delta) => {
    if (!delta || !delta.id || !delta.state || delta.state.current !== 'complete') return;
    const jobId = nativeDownloadJobs.get(delta.id);
    if (jobId) {
      nativeDownloadJobs.delete(delta.id);
      removePersistedDownloadJob(delta.id);
      finishNativeDownload(jobId);
      return;
    }
    api.storage.local.get(nativeDownloadStorageKey).then((stored) => {
      const jobs = stored[nativeDownloadStorageKey] || {};
      const persistedJobId = jobs[delta.id];
      if (!persistedJobId) return;
      delete jobs[delta.id];
      api.storage.local.set({ [nativeDownloadStorageKey]: jobs });
      finishNativeDownload(persistedJobId);
    }).catch(() => {});
  });
}

function removePersistedDownloadJob(downloadId) {
  api.storage.local.get(nativeDownloadStorageKey).then((stored) => {
    const jobs = stored[nativeDownloadStorageKey] || {};
    delete jobs[downloadId];
    return api.storage.local.set({ [nativeDownloadStorageKey]: jobs });
  }).catch(() => {});
}

function finishNativeDownload(jobId) {
  sendNative({ action: 'removeCompletedFile', jobId })
    .then((result) => {
      if (result && result.ok && registry[jobId]) {
        registry[jobId].snapshot.filepath = null;
        saveRegistry();
      }
    })
    .catch((err) => console.warn('[youDl] Could not remove temporary native copy:', err));
}

/* ── job registry (persisted; survives worker recycling) ─────────────── */

// { [jobId]: { jobId, videoId, preset, snapshot, terminalSince } }
let registry = {};
let hydrated = false;

function saveRegistry() {
  // Retain download history permanently (keep up to 100 most recent items)
  const keys = Object.keys(registry);
  if (keys.length > 100) {
    keys.sort((a, b) => (registry[a].createdAt || 0) - (registry[b].createdAt || 0));
    while (keys.length > 100) {
      delete registry[keys.shift()];
    }
  }
  api.storage.local.set({ ydlJobs: registry }).catch(() => {});
}

async function hydrate() {
  if (hydrated) return;
  const data = await api.storage.local.get('ydlJobs').catch(() => ({}));
  registry = (data && data.ydlJobs) || {};
  hydrated = true;
}

/* ── background poller ───────────────────────────────────────────────── */

let pollTimer = null;

function anyActive() {
  return Object.values(registry).some((j) => !j.terminalSince);
}

function ensurePolling() {
  if (pollTimer || !anyActive()) return;
  pollTimer = setInterval(pollOnce, 1000);
}

async function pollOnce() {
  let changed = false;
  for (const j of Object.values(registry)) {
    if (j.terminalSince) continue; // already finished; snapshot kept as-is
    try {
      const data = await helperFetch(`/jobs/${j.jobId}`);
      if (!data) continue;
      if (data.error) {
        // The helper no longer knows this job (it was restarted — its job
        // store is memory-only). Retire the ghost: keep the last real
        // snapshot state but mark terminal so the UI stops tracking it.
        if (j.snapshot) { j.snapshot.status = 'canceled'; j.snapshot.error = null; }
        else { j.snapshot = { status: 'canceled', progress: {} }; }
        j.terminalSince = Date.now();
      } else {
        j.snapshot = data;
        if (['done', 'error', 'canceled'].includes(data.status)) {
          j.terminalSince = Date.now();
          if (data.status === 'done' && !j.browserDownloaded && !j.directSave) {
            triggerBrowserDownload(j, data);
          }
        }
      }
      changed = true;
    } catch (e) {
      // helper offline, 404, or any other error: keep the last snapshot;
      // pollOnce will reconverge when the helper is reachable again
      if (e && e.http === 404) {
        if (j.snapshot) { j.snapshot.status = 'canceled'; j.snapshot.error = null; }
        else { j.snapshot = { status: 'canceled', progress: {} }; }
        j.terminalSince = Date.now();
        changed = true;
      }
    }
  }
  if (!anyActive()) { clearInterval(pollTimer); pollTimer = null; }
  if (changed) saveRegistry();
}

async function triggerBrowserDownload(j, data) {
  if (j.browserDownloaded) return;
  j.browserDownloaded = true;
  saveRegistry();

  if (!api.downloads || !api.downloads.download) return;
  const url = nativePort
    ? `http://127.0.0.1:8766/jobs/${j.jobId}/file`
    : `${API_BASE}/jobs/${j.jobId}/file`;
  let filename = undefined;
  if (data.filepath) {
    const parts = data.filepath.split(/[/\\]/);
    filename = parts[parts.length - 1];
  }

  // Check saveAs user setting (default true)
  const stored = await api.storage.local.get('ydlSaveAs').catch(() => ({}));
  const saveAs = stored && stored.ydlSaveAs !== undefined ? !!stored.ydlSaveAs : true;

  try {
    api.downloads.download({
      url,
      filename,
      saveAs,
    }, (id) => {
      if (api.runtime.lastError) {
        console.warn('[youDl] download manager notice:', api.runtime.lastError.message);
      } else if (nativePort && typeof id === 'number') {
        nativeDownloadJobs.set(id, j.jobId);
        api.storage.local.get(nativeDownloadStorageKey).then((stored) => {
          const jobs = stored[nativeDownloadStorageKey] || {};
          jobs[id] = j.jobId;
          return api.storage.local.set({ [nativeDownloadStorageKey]: jobs });
        }).catch(() => {});
      }
    });
  } catch (err) {
    console.warn('[youDl] error triggering browser download:', err);
  }
}

// MV3 service workers get killed when idle — an alarm revives us to catch up.
try {
  api.alarms.create('ydl-poll', { periodInMinutes: 0.5 });
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'ydl-poll') hydrate().then(ensurePolling).then(() => pollOnce());
  });
} catch (_) { /* alarms unavailable */ }

/* ── helper proxy ────────────────────────────────────────────────────── */

/* ── Native Messaging Host bridge (Chrome, Brave, Edge, Firefox) ──────── */

const NATIVE_HOST = 'com.youdl.helper';
let nativePort = null;
let nativePending = new Map();
let nextMsgId = 1;
let nativeDisabled = false;

function ensureNativePort() {
  if (nativePort) return nativePort;
  if (nativeDisabled) return null;
  if (!api.runtime || !api.runtime.connectNative) return null;

  try {
    const port = api.runtime.connectNative(NATIVE_HOST);
    nativePort = port;

    port.onMessage.addListener((msg) => {
      if (!msg) return;

      // Realtime push update from native host
      if (msg.event === 'jobsUpdate' && Array.isArray(msg.jobs)) {
        let changed = false;
        for (const j of msg.jobs) {
          if (!j || !j.jobId) continue;
          if (registry[j.jobId]) {
            registry[j.jobId].snapshot = j;
            if (['done', 'error', 'canceled'].includes(j.status)) {
              if (!registry[j.jobId].terminalSince) {
                registry[j.jobId].terminalSince = Date.now();
                if (j.status === 'done' && !registry[j.jobId].browserDownloaded && !registry[j.jobId].directSave) {
                  triggerBrowserDownload(registry[j.jobId], j);
                }
              }
            }
            changed = true;
          }
        }
        if (changed) saveRegistry();
        return;
      }

      if (msg.id && nativePending.has(msg.id)) {
        const { resolve, timer } = nativePending.get(msg.id);
        clearTimeout(timer);
        nativePending.delete(msg.id);
        resolve(msg);
      }
    });

    port.onDisconnect.addListener(() => {
      const err = api.runtime.lastError ? api.runtime.lastError.message : 'disconnected';
      console.warn('[youDl] Native host disconnected:', err);
      nativePort = null;
      for (const [id, req] of nativePending) {
        clearTimeout(req.timer);
        req.reject(new Error(err));
      }
      nativePending.clear();
      // If host not found on system, temporarily back off
      if (/not found|cannot find/i.test(err)) {
        nativeDisabled = true;
        setTimeout(() => { nativeDisabled = false; }, 8000);
      }
    });

    return nativePort;
  } catch (e) {
    console.warn('[youDl] Native host init exception:', e);
    nativePort = null;
    return null;
  }
}

function sendNative(req, timeoutMs = 25000) {
  const port = ensureNativePort();
  if (!port) return Promise.reject(new Error('Native host not connected'));

  return new Promise((resolve, reject) => {
    const id = nextMsgId++;
    const timer = setTimeout(() => {
      nativePending.delete(id);
      reject(new Error(`Native request timed out: ${req.path || req.action}`));
    }, timeoutMs);

    nativePending.set(id, { resolve, reject, timer });
    try {
      port.postMessage({ id, ...req });
    } catch (e) {
      clearTimeout(timer);
      nativePending.delete(id);
      reject(e);
    }
  });
}

/* ── HTTP helper fallback proxy ───────────────────────────────────────── */

let cachedToken = null;

async function helperToken(force = false) {
  if (cachedToken && !force) return cachedToken;
  const res = await fetch(API_BASE + '/ping');
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'helper not ready');
  cachedToken = data.token;
  return cachedToken;
}

async function httpHelperFetch(path, { method = 'GET', body = null, retryAuth = true } = {}) {
  const token = await helperToken();
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-youdl-token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403 && retryAuth) {
    cachedToken = null;
    return httpHelperFetch(path, { method, body, retryAuth: false });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.http = res.status;
    throw err;
  }
  return data;
}

async function helperFetch(path, { method = 'GET', body = null, retryAuth = true } = {}) {
  // 1. Try Native Messaging Host first!
  if (!nativeDisabled && api.runtime && api.runtime.connectNative) {
    try {
      const resp = await sendNative({ path, method, body });
      if (resp && resp.ok) {
        return resp.data;
      }
      if (resp && resp.error) {
        throw new Error(resp.error);
      }
    } catch (e) {
      const msg = String(e.message || e);
      // Fall through to HTTP only if native connection wasn't established
      if (!/not found|disconnected|not connected|cannot find/i.test(msg)) {
        throw e;
      }
    }
  }

  // 2. HTTP Fallback
  return httpHelperFetch(path, { method, body, retryAuth });
}

/* ── messaging ───────────────────────────────────────────────────────── */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'YDL_PAGE_VIDEO') {
    if (sender.tab && sender.tab.id !== undefined) {
      if (msg.videoUrl) {
        tabVideos.set(sender.tab.id, msg.videoUrl);
        action.setBadgeText({ tabId: sender.tab.id, text: '▶' });
        action.setBadgeBackgroundColor({ color: '#1f6feb' });
      } else {
        tabVideos.delete(sender.tab.id);
        action.setBadgeText({ tabId: sender.tab.id, text: '' });
      }
    }
    sendResponse({ ok: true });
  }

  // Content-script API proxy. When a download STARTS here (pill or popup),
  // register it in the registry so state survives navigation and UI reloads.
  if (msg && msg.type === 'YDL_API') {
    hydrate()
      .then(async () => {
        const method = msg.method || 'GET';
        let body = msg.body || null;
        let directSave = false;
        if (msg.path === '/jobs' && method === 'POST') {
          const prefs = await api.storage.local.get(['ydlAutoSave', 'ydlSaveDir']).catch(() => ({}));
          if (prefs.ydlAutoSave) {
            const output = String(prefs.ydlSaveDir || '').trim();
            if (!output) throw new Error('Enter an auto-save folder path in the popup settings.');
            body = { ...(body || {}), output };
            directSave = true;
          }
        }
        return { data: await helperFetch(msg.path, { method, body }), directSave, body };
      })
      .then(({ data, directSave, body }) => {
        let out = data;
        if (msg.path.startsWith('/jobs') && (msg.method || 'GET') === 'POST' && data && data.jobId) {
          registry[data.jobId] = {
            jobId: data.jobId,
            videoId: extractVideoId(body && body.url),
            title: (body && body.title) || (data && data.title) || null,
            preset: (body && body.preset) || data.preset || 'best',
            format: (body && body.format) || data.format || 'mp4',
            directSave,
            snapshot: data,
            terminalSince: null,
            createdAt: data.createdAt || Date.now(),
          };
          saveRegistry();
          ensurePolling();
        }
        sendResponse({ ok: true, data: out });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async
  }

  // Query: which jobs do we know for this video (or all jobs if videoId is omitted)?
  if (msg && msg.type === 'YDL_JOBS_GET') {
    hydrate().then(() => {
      const wanted = [];
      for (const j of Object.values(registry)) {
        if (msg.videoId !== undefined && msg.videoId !== null && j.videoId !== msg.videoId) continue;
        wanted.push({
          jobId: j.jobId,
          videoId: j.videoId,
          title: j.title || (j.snapshot && j.snapshot.title) || null,
          preset: j.preset,
          format: j.format || (j.snapshot && j.snapshot.format) || 'mp4',
          snapshot: j.snapshot,
          createdAt: j.createdAt,
        });
      }
      // newest first
      wanted.sort((a, b) => b.jobId - a.jobId);
      sendResponse({ ok: true, jobs: wanted });
    });
    return true;
  }

  if (msg && msg.type === 'YDL_CLEAR_HISTORY') {
    hydrate().then(() => {
      for (const id of Object.keys(registry)) {
        const j = registry[id];
        if (['done', 'error', 'canceled'].includes((j.snapshot || {}).status)) {
          delete registry[id];
        }
      }
      saveRegistry();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg && msg.type === 'YDL_GET_TAB_VIDEO') {
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      const url = t
        ? tabVideos.get(t.id) || (t.url && /(^|\.)youtube\.com\/.+/i.test(t.url) ? t.url : null)
        : null;
      sendResponse({ url, tabUrl: t ? t.url : null });
    });
    return true; // async
  }

  if (msg && msg.type === 'YDL_OPEN_URL') {
    api.tabs.create({ url: msg.url });
    sendResponse({ ok: true });
  }
  return false;
});

/* ── helpers ─────────────────────────────────────────────────────────── */

function extractVideoId(url) {
  if (!url) return null;
  const m = String(url).match(/\b(?:v|video_id|shorts[\/?]|shorts\/)=?([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  const s = String(url).match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
  return s ? s[1] : null;
}

/* ── icon badge + tab lifecycle ──────────────────────────────────────── */

const tabVideos = new Map();

api.tabs.onRemoved.addListener((tabId) => tabVideos.delete(tabId));

api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    tabVideos.delete(tabId);
    action.setBadgeText({ tabId, text: '' });
  }
});

hydrate().then(ensurePolling);
