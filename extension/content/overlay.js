/**
 * youDl overlay — IDM-style hover download button on YouTube players.
 *
 * A "⬇" pill floats over the player while the pointer is over the video.
 * Clicking it opens a compact quality panel *on the video itself*; picking
 * one starts the download through the helper and turns the pill into a
 * live progress meter until the file is in ~/Downloads/youDl.
 *
 * State model: the pill holds NO truth of its own. The background service
 * worker registers and polls every download (from the pill OR the popup),
 * caches, and persists the result — so after SPA navigation away and back,
 * closing the popup, or even a full page reload, the pill re-renders the
 * real state of this video's latest job.
 *
 * Runs in the page's isolated world: page CSP blocks fetch() to
 * 127.0.0.1 here, so all helper traffic goes through the background
 * service worker (YDL_API messages). No page globals are touched.
 */
(function () {
'use strict';

const PRESETS = [
  { value: 'best',  label: 'Best available' },
  { value: '1080',  label: '1080p' },
  { value: '720',   label: '720p' },
  { value: '480',   label: '480p' },
  { value: '360',   label: '360p' },
  { value: 'audio', label: 'Audio only' },
];

/* ── diagnostics ─────────────────────────────────────────────────────── */

const DBG = localStorage.getItem('ydl-debug') === '1';
function log(...args) { if (DBG) console.info('[youDl]', ...args); }

window.addEventListener('error', (e) => {
  if (e && String(e.filename || '').includes('overlay.js')) {
    console.error('[youDl] script error:', e.message, e.lineno);
  }
});

console.info('[youDl] overlay injected on', location.pathname);

/* ── state ───────────────────────────────────────────────────────────── */

const state = {
  player: null,        // .html5-video-player element we're attached to
  videoId: null,       // current page's video id
  hoverTimer: null,
  panel: null,
  pill: null,
  lastRendered: null,  // JSON of last rendered state — skip redundant paints
  selectedFormat: 'mp4',
  resolving: false,
  estimatedSizes: null,
  resolvedVideoId: null,
};

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!n || isNaN(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ── current video id (covers watch, shorts, other player pages) ─────── */

function currentVideoId() {
  const m = location.href.match(/\/watch\?[^#]*\b(v|video_id)=([A-Za-z0-9_-]{6,})/)
      || location.href.match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
  return m ? (m[2] || m[1]) : null;
}

/* ── background bridge ───────────────────────────────────────────────── */

let dead = false; // extension was reloaded/unloaded while THIS page stayed open

function isCtxInvalidated(e) {
  return /context invalidated/i.test(String(e) || '')
    || /context invalidated/i.test(String(chrome.runtime.lastError || ''));
}

function shutdownQuietly() {
  if (state.mainLoop) { clearInterval(state.mainLoop); state.mainLoop = null; }
  dead = true;
  if (state.pill) { state.pill.remove(); state.pill = null; }
  closePanel();
  console.info('[youDl] extension context lost (extension reloaded?) — overlay stopped. Refresh this tab to get it back.');
}

function bgSend(msg) {
  if (dead) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (isCtxInvalidated()) { shutdownQuietly(); resolve(null); return; }
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch (e) {
      if (isCtxInvalidated(e)) shutdownQuietly();
      resolve(null);
    }
  });
}

async function postJob(preset, format) {
  const videoUrl = `https://www.youtube.com/watch?v=${state.videoId}`;
  const resp = await bgSend({
    type: 'YDL_API',
    path: '/jobs',
    method: 'POST',
    body: { url: videoUrl, preset, format: format || state.selectedFormat || 'mp4' },
  });
  if (!resp || resp.ok === false) throw new Error(resp?.error || 'helper unavailable');
  return resp.data;
}

async function cancelJob(jobId) {
  return bgSend({ type: 'YDL_API', path: `/jobs/${jobId}/cancel`, method: 'POST', body: {} });
}

async function fetchState() {
  const resp = await bgSend({ type: 'YDL_JOBS_GET', videoId: state.videoId });
  if (!resp || !resp.ok) return [];
  return resp.jobs || [];
}

async function ensureMetadata() {
  if (state.resolvedVideoId === state.videoId && state.estimatedSizes) return state.estimatedSizes;
  state.resolving = true;
  try {
    const resp = await bgSend({
      type: 'YDL_API',
      path: '/resolve',
      method: 'POST',
      body: { url: `https://www.youtube.com/watch?v=${state.videoId}` },
    });
    if (resp && resp.ok && resp.data) {
      state.estimatedSizes = resp.data.estimatedSizes || null;
      state.resolvedVideoId = state.videoId;
    }
  } catch (e) {
    console.warn('[youDl] resolve in overlay:', e);
  } finally {
    state.resolving = false;
  }
  return state.estimatedSizes;
}

/* ── overlay construction ────────────────────────────────────────────── */

const CSS = `
.ydl-pill {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 999999;
  background: rgba(15, 20, 24, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 18px;
  padding: 5px 12px;
  color: #fff;
  font: 600 12px/1.3 system-ui, sans-serif;
  cursor: pointer;
  user-select: none;
  box-shadow: 0 2px 10px rgba(0,0,0,0.35);
  display: flex;
  align-items: center;
  gap: 6px;
  transition: background 0.15s;
}
.ydl-pill:hover { background: rgba(31,102,235,0.95); }
.ydl-pill.busy { cursor: default; }
.ydl-pill .ydl-bar {
  display: inline-block;
  width: 46px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255,255,255,0.25);
  overflow: hidden;
}
.ydl-pill .ydl-bar > span {
  display: block;
  height: 100%;
  width: 0%;
  background: #8ab4f8;
  transition: width 0.4s ease;
}
.ydl-panel {
  position: absolute;
  top: 42px;
  right: 10px;
  z-index: 999999;
  background: rgba(18, 22, 26, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 10px;
  padding: 8px;
  min-width: 210px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.5);
  font: 13px/1.4 system-ui, sans-serif;
}
.ydl-panel .ydl-q {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  color: #e6edf3;
  font-size: 13px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.ydl-panel .ydl-q:hover { background: rgba(31,102,235,0.18); }
.ydl-panel .ydl-head {
  padding: 2px 10px 6px;
  color: #9aa7b3;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.ydl-panel .ydl-head b { color: #e6edf3; font-size: 12px; display: block; margin-top: 2px; }
.ydl-panel .ydl-err { padding: 6px 10px; color: #ff9189; font-size: 12px; }
.ydl-panel .ydl-fmt-row {
  display: flex;
  gap: 5px;
  padding: 4px 6px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
  margin-bottom: 6px;
}
.ydl-panel .ydl-fmt-btn {
  flex: 1;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12);
  color: #9aa7b3;
  padding: 4px 6px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  transition: all 0.15s;
}
.ydl-panel .ydl-fmt-btn:hover {
  background: rgba(255,255,255,0.12);
  color: #fff;
}
.ydl-panel .ydl-fmt-btn.active {
  background: #1f6feb;
  border-color: #1f6feb;
  color: #ffffff;
}
.ydl-panel .ydl-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  color: #9aa7b3;
  font-size: 11px;
}
.ydl-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,0.2);
  border-top-color: #1f6feb;
  border-radius: 50%;
  animation: ydl-spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes ydl-spin { to { transform: rotate(360deg); } }
`;
const styleEl = document.createElement('style');
styleEl.textContent = CSS;
document.documentElement.appendChild(styleEl);

function ensureOverlay(player) {
  if (!state.pill || !state.pill.isConnected) {
    state.pill = document.createElement('div');
    state.pill.className = 'ydl-pill';
    state.pill.innerHTML = '⬇ <span>youDl</span>';
    player.appendChild(state.pill);
    state.lastRendered = null;
    state.pill.addEventListener('click', togglePanel);

    player.addEventListener('mouseleave', scheduleHide);
    player.addEventListener('mouseenter', clearTimeoutMaybe);
    player.addEventListener('mousemove', clearTimeoutMaybe);
    state.pill.addEventListener('mouseenter', clearTimeoutMaybe);
    state.pill.addEventListener('mouseleave', scheduleHide);
  } else if (state.pill.parentElement !== player) {
    player.appendChild(state.pill);
    state.lastRendered = null;
  }
}

function clearTimeoutMaybe() {
  if (state.hoverTimer) { clearTimeout(state.hoverTimer); state.hoverTimer = null; }
  if (state.pill) state.pill.style.display = '';
}

function scheduleHide() {
  state.hoverTimer = setTimeout(() => {
    if (state.pill && !state.panel) state.pill.style.display = 'none';
    if (state.panel) closePanel();
  }, 600);
}

/* ── pill rendering (driven by background state) ─────────────────────── */

function renderPill(job) {
  let html;
  if (!job) html = '⬇ <span>youDl</span>';
  else {
    const s = job.snapshot || {};
    const p = s.progress || {};
    if (s.status === 'downloading' || s.status === 'queued') {
      html = `<span class="ydl-bar"><span style="width:${p.pct || 0}%"></span></span>`
           + `<span>${s.status === 'queued' ? 'queued…' : `${p.pct || 0}%`}</span>`;
    } else if (s.status === 'postprocessing') {
      html = `<span class="ydl-bar"><span style="width:99%"></span></span>`
           + `<span>merging…</span>`;
    } else if (s.status === 'done') {
      html = `<span>saved ✓</span>`;
    } else if (s.status === 'error') {
      html = `<span>failed</span>`;
    } else if (s.status === 'canceled') {
      html = '⬇ <span>youDl</span>';
    } else {
      html = '⬇ <span>youDl</span>';
    }
  }
  const key = `${job ? job.jobId + ':' : ''}|${html}`;
  if (state.lastRendered === key) return;
  state.lastRendered = key;
  state.pill.classList.toggle('busy', !!job && ['queued','downloading','done'].includes((job.snapshot||{}).status));
  state.pill.innerHTML = html;
}

/* ── panel (done state offers cancel / fine-grain list too) ──────────── */

function closePanel() {
  if (state.panel) { state.panel.remove(); state.panel = null; }
}

function togglePanel() {
  if (state.panel) { closePanel(); return; }
  openPanel();
}

async function openPanel() {
  closePanel();
  const panel = document.createElement('div');
  panel.className = 'ydl-panel';
  panel.innerHTML = `<div class="ydl-head">youDl — download this video</div>`;
  state.panel = panel;
  state.player.appendChild(panel);

  // Show known jobs for this video, with actions.
  const jobs = await fetchState();
  const active = jobs.filter((j) => ['queued', 'downloading'].includes((j.snapshot || {}).status));
  const done = jobs.filter((j) => (j.snapshot || {}).status === 'done');

  if (active.length) {
    for (const j of active) {
      const s = j.snapshot;
      const row = document.createElement('div');
      row.className = 'ydl-head';
      row.innerHTML = `<b>${s.format || j.preset} · ${s.status}</b> ${s.progress?.pct ?? 0}% — file saved to ~/Downloads/youDl when done`;
      const c = document.createElement('button');
      c.className = 'ydl-q';
      c.textContent = 'Cancel this download';
      c.addEventListener('click', () => { cancelJob(j.jobId); closePanel(); });
      panel.appendChild(row);
      panel.appendChild(c);
    }
    return;
  }
  if (done.length) {
    const row = document.createElement('div');
    row.className = 'ydl-head';
    row.textContent = 'Saved: ' + done.map((j) => `~/Downloads/youDl · ${j.snapshot.format || j.preset}`).join(', ');
    panel.appendChild(row);
  }

  const fmtRow = document.createElement('div');
  fmtRow.className = 'ydl-fmt-row';
  const formats = [
    { id: 'mp4', label: 'MP4' },
    { id: 'webm', label: 'WebM' },
    { id: 'mp3', label: 'MP3' },
  ];
  formats.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = 'ydl-fmt-btn' + (state.selectedFormat === f.id ? ' active' : '');
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      state.selectedFormat = f.id;
      openPanel();
    });
    fmtRow.appendChild(btn);
  });
  panel.appendChild(fmtRow);

  if (state.selectedFormat === 'mp3') {
    const sz = state.estimatedSizes?.mp3?.audio || state.estimatedSizes?.mp4?.audio;
    const b = document.createElement('button');
    b.className = 'ydl-q';
    b.textContent = sz ? `Download MP3 Audio (~${fmtBytes(sz)})` : 'Download MP3 Audio';
    b.addEventListener('click', () => startJob('audio', 'mp3'));
    panel.appendChild(b);
  } else {
    for (const p of PRESETS) {
      const sz = state.estimatedSizes?.[state.selectedFormat]?.[p.value] || state.estimatedSizes?.mp4?.[p.value];
      const b = document.createElement('button');
      b.className = 'ydl-q';
      b.textContent = sz ? `${p.label} (~${fmtBytes(sz)})` : p.label;
      b.addEventListener('click', () => startJob(p.value, state.selectedFormat));
      panel.appendChild(b);
    }
  }

  // If sizes are still being analyzed in background, show loading indicator and trigger resolution
  if (state.resolvedVideoId !== state.videoId) {
    const loadEl = document.createElement('div');
    loadEl.className = 'ydl-loading';
    loadEl.innerHTML = '<span class="ydl-spinner"></span> Analyzing sizes…';
    panel.appendChild(loadEl);
    ensureMetadata().then(() => {
      if (state.panel) openPanel();
    });
  }
}

function panelError(msg) {
  if (!state.panel) return;
  const e = document.createElement('div');
  e.className = 'ydl-err';
  e.textContent = msg;
  state.panel.appendChild(e);
}

/* ── job start ───────────────────────────────────────────────────────── */

async function startJob(preset, format) {
  try {
    closePanel();
    await postJob(preset, format || state.selectedFormat);   // background registers + polls; pill re-renders from registry
  } catch (e) {
    openPanel();
    panelError(e.message);
  }
}

/* ── overlay discovery ───────────────────────────────────────────────── */

function findPlayer() {
  let p = document.querySelector('.html5-video-player:not(.ytp-embedded)');
  if (!p && location.pathname.startsWith('/shorts')) {
    p = document.querySelector('ytmusic-player html5-video-player, .html5-video-player');
  }
  if (p && !p.contains(state.pill)) {
    state.pill = null; // player DOM swapped — pill is gone with it
  }
  return p;
}

async function syncJobState() {
  const jobs = await fetchState();
  const latest = jobs[0] || null;
  renderPill(latest);
  return jobs;
}

function tick() {
  const id = currentVideoId();
  if (id !== state.videoId) {
    if (id) { console.info('[youDl] video changed →', id); }
    state.videoId = id;
    state.lastRendered = null;
    closePanel();
  }
  if (!state.videoId) return;

  const player = findPlayer();
  if (player && player !== state.player) {
    state.player = player;
    ensureOverlay(player);
  }
  if (!player && state.pill && state.pill.isConnected) {
    state.pill.style.display = 'none';   // left the player; registry keeps state
  }
}

// Lightweight loop: discovery + re-render of true state both run here.
state.mainLoop = setInterval(() => {
  if (dead) return;
  tick();
  if (state.videoId) syncJobState();
}, 750);
tick();
if (state.videoId) syncJobState();
})();