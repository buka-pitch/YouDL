/**
 * youDl thumbnails — download buttons on YouTube listing pages.
 *
 * Scans the page for video thumbnail cards (home, search, channel,
 * subscriptions, trending, playlists) and injects a small "⬇" button
 * on each thumbnail. Clicking it opens a compact quality/format picker.
 *
 * Works alongside overlay.js (which handles the *player* on /watch pages).
 * Both scripts co-exist safely — this one only touches thumbnails, the
 * other only touches the .html5-video-player element.
 *
 * All downloads go through the background service worker (YDL_API),
 * so job state is centrally tracked, persisted, and visible in the popup.
 */
(function () {
'use strict';

// Avoid duplicate script execution if dynamically injected
if (window.__ydl_thumbs_injected) {
  if (typeof window.__ydl_rescan === 'function') {
    window.__ydl_rescan(true);
  }
  return;
}
window.__ydl_thumbs_injected = true;

/* ── diagnostics ──────────────────────────────────────────────────────── */

const DBG = true; // set to false once everything works
function log(...args) { if (DBG) console.info('[youDl:thumbs]', ...args); }

console.info('[youDl] thumbnail overlay loaded on', location.pathname);

/* ── constants ────────────────────────────────────────────────────────── */

const PRESETS = [
  { value: 'best',  label: 'Best' },
  { value: '1080',  label: '1080p' },
  { value: '720',   label: '720p' },
  { value: '480',   label: '480p' },
  { value: '360',   label: '360p' },
  { value: 'audio', label: 'Audio' },
];

const FORMATS = [
  { id: 'mp4',  label: 'MP4' },
  { id: 'webm', label: 'WebM' },
  { id: 'mp3',  label: 'MP3' },
];

// Attribute to mark processed thumbnails
const MARKER = 'data-ydl-thumb';

/* ── state ────────────────────────────────────────────────────────────── */

let dead = false;
let selectedFormat = 'mp4';
let activePanel = null;   // the currently open mini-panel element
let activePanelCard = null; // which thumbnail card the panel belongs to

/* ── background bridge ────────────────────────────────────────────────── */

function isCtxInvalidated(e) {
  return /context invalidated/i.test(String(e) || '')
    || /context invalidated/i.test(String(chrome.runtime.lastError || ''));
}

function bgSend(msg) {
  if (dead) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (isCtxInvalidated()) { dead = true; resolve(null); return; }
        void chrome.runtime.lastError;
        resolve(resp || null);
      });
    } catch (e) {
      if (isCtxInvalidated(e)) dead = true;
      resolve(null);
    }
  });
}

async function postJob(videoId, preset, format, title) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const resp = await bgSend({
    type: 'YDL_API',
    path: '/jobs',
    method: 'POST',
    body: { url: videoUrl, preset, format, title: title || null },
  });
  if (!resp || resp.ok === false) throw new Error(resp?.error || 'helper unavailable');
  return resp.data;
}

/* ── styles ───────────────────────────────────────────────────────────── */

const CSS = `
/* Download button on thumbnails */
.ydl-thumb-btn {
  position: absolute;
  bottom: 6px;
  right: 6px;
  z-index: 800;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: rgba(15, 20, 24, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: scale(0.85);
  transition: opacity 0.15s, transform 0.15s, background 0.15s;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  pointer-events: auto;
  line-height: 1;
}
.ydl-thumb-btn:hover {
  background: rgba(31, 102, 235, 0.95);
  transform: scale(1);
}
.ydl-thumb-btn.ydl-downloading {
  opacity: 1 !important;
  transform: scale(1) !important;
  background: rgba(31, 102, 235, 0.85);
  cursor: default;
  pointer-events: none;
}

/* Show button on thumbnail hover — broad selectors to cover all YT layouts */
*:hover > .ydl-thumb-btn,
.ydl-thumb-btn:hover,
.ydl-thumb-btn.ydl-visible,
[data-ydl-thumb]:hover .ydl-thumb-btn,
#related :hover > .ydl-thumb-btn,
#secondary :hover > .ydl-thumb-btn,
#thumbnail-container:hover .ydl-thumb-btn,
ytd-thumbnail:hover .ydl-thumb-btn,
a#thumbnail:hover .ydl-thumb-btn,
ytd-rich-grid-media:hover .ydl-thumb-btn,
ytd-rich-item-renderer:hover .ydl-thumb-btn,
ytd-video-renderer:hover .ydl-thumb-btn,
ytd-compact-video-renderer:hover .ydl-thumb-btn,
ytd-grid-video-renderer:hover .ydl-thumb-btn,
a.ytLockupViewModelContentImage:hover .ydl-thumb-btn,
.ytLockupViewModelHost:hover .ydl-thumb-btn,
yt-lockup-view-model:hover .ydl-thumb-btn,
yt-compact-video-view-model:hover .ydl-thumb-btn {
  opacity: 1;
  transform: scale(1);
}

/* Mini panel — fixed to viewport, escapes overflow:hidden containers */
.ydl-thumb-panel {
  position: fixed;
  z-index: 2147483647;
  background: rgba(18, 22, 26, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 10px;
  padding: 6px;
  min-width: 165px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.55);
  font: 12px/1.4 system-ui, sans-serif;
  color: #e6edf3;
  pointer-events: auto;
}

.ydl-thumb-panel .ydl-tp-title {
  padding: 3px 8px 5px;
  font-size: 11px;
  font-weight: 600;
  color: #9aa7b3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  margin-bottom: 4px;
}

.ydl-thumb-panel .ydl-tp-fmt-row {
  display: flex;
  gap: 3px;
  padding: 3px 4px 6px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  margin-bottom: 4px;
}
.ydl-thumb-panel .ydl-tp-fmt {
  flex: 1;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  color: #9aa7b3;
  padding: 3px 4px;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  transition: all 0.12s;
}
.ydl-thumb-panel .ydl-tp-fmt:hover {
  background: rgba(255,255,255,0.12);
  color: #fff;
}
.ydl-thumb-panel .ydl-tp-fmt.active {
  background: #1f6feb;
  border-color: #1f6feb;
  color: #fff;
}

.ydl-thumb-panel .ydl-tp-q {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  color: #e6edf3;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
  font-weight: 500;
}
.ydl-thumb-panel .ydl-tp-q:hover {
  background: rgba(31, 102, 235, 0.18);
}

.ydl-thumb-panel .ydl-tp-msg {
  padding: 5px 8px;
  font-size: 11px;
  color: #8ab4f8;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ydl-thumb-panel .ydl-tp-msg.err { color: #ff9189; }

.ydl-tp-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid rgba(255,255,255,0.2);
  border-top-color: #1f6feb;
  border-radius: 50%;
  animation: ydl-tp-spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes ydl-tp-spin { to { transform: rotate(360deg); } }

/* Circular progress ring inside the button */
.ydl-ring-svg {
  position: absolute;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ydl-ring-bg {
  fill: none;
  stroke: rgba(255,255,255,0.12);
  stroke-width: 2.5;
}
.ydl-ring-fg {
  fill: none;
  stroke: #8ab4f8;
  stroke-width: 2.5;
/* youDl Masthead Scan Button */
.ydl-masthead-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: #f1f1f1;
  padding: 5px 12px;
  border-radius: 18px;
  font: 500 12px/1 system-ui, sans-serif;
  cursor: pointer;
  margin-right: 8px;
  transition: all 0.15s ease;
  vertical-align: middle;
  user-select: none;
}
.ydl-masthead-btn:hover {
  background: rgba(31, 111, 235, 0.25);
  border-color: #388bfd;
  color: #fff;
  box-shadow: 0 0 10px rgba(31, 111, 235, 0.3);
}
.ydl-masthead-btn:active {
  transform: scale(0.96);
}
.ydl-mb-icon {
  color: #8ab4f8;
  font-size: 13px;
  font-weight: 700;
}
.ydl-masthead-btn.spinning .ydl-mb-icon {
  display: inline-block;
  animation: ydl-tp-spin 0.6s linear infinite;
}

/* Scan Toast Notification */
.ydl-scan-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483647;
  background: rgba(16, 20, 24, 0.94);
  border: 1px solid rgba(63, 185, 80, 0.45);
  color: #3fb950;
  padding: 8px 16px;
  border-radius: 8px;
  font: 600 12px/1.4 system-ui, sans-serif;
  box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  opacity: 0;
  transform: translateY(12px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  pointer-events: none;
}
.ydl-scan-toast.ydl-toast-show {
  opacity: 1;
  transform: translateY(0);
}
`;

const styleEl = document.createElement('style');
styleEl.textContent = CSS;
document.documentElement.appendChild(styleEl);

/* ── video ID extraction from a thumbnail link ────────────────────────── */

function extractVideoId(href) {
  if (!href) return null;
  let m;
  if ((m = href.match(/\/watch\?[^#]*\b(?:v|video_id)=([A-Za-z0-9_-]{11})/))) return m[1];
  if ((m = href.match(/\/shorts\/([A-Za-z0-9_-]{11})/))) return m[1];
  return null;
}

/* ── extract title from a video card ──────────────────────────────────── */

function extractTitle(card) {
  // Try common YouTube title selectors (old layout)
  const titleEl =
    card.querySelector('#video-title') ||
    card.querySelector('a#video-title-link') ||
    card.querySelector('[id="video-title"]') ||
    card.querySelector('yt-formatted-string.ytd-rich-grid-media') ||
    card.querySelector('span#video-title') ||
    card.querySelector('h3 a');
  if (titleEl) {
    return (titleEl.textContent || titleEl.getAttribute('title') || '').trim();
  }

  // NEW layout: yt-lockup-view-model metadata area
  const lockupMeta = card.querySelector('.ytLockupViewModelMetadata');
  if (lockupMeta) {
    // Title is usually the first text content in metadata
    const metaTitle = lockupMeta.querySelector('h3, [class*="title"], a');
    if (metaTitle) return (metaTitle.textContent || metaTitle.getAttribute('title') || '').trim();
    // Fallback: first meaningful text
    const txt = lockupMeta.textContent?.trim();
    if (txt) return txt.split('\n')[0].trim();
  }

  // Fallback: look for title attribute on links
  const link = card.querySelector('a[title]');
  if (link) return link.getAttribute('title').trim();

  // Fallback: aria-label on the card or its thumbnail link
  const ariaEl = card.querySelector('[aria-label]');
  if (ariaEl) return ariaEl.getAttribute('aria-label').trim();

  return null;
}

/* ── find the thumbnail element in a video card ───────────────────────── */

function findThumbContainer(card) {
  // 1. Modern YouTube lockup thumbnail link or view-model (home, sidebar, search)
  const lockupImg = card.querySelector(
    'a.ytLockupViewModelContentImage, a[class*="ContentImage"], a[class*="content-image"], yt-thumbnail-view-model'
  );
  if (lockupImg) return lockupImg;

  // 2. Classic thumbnail containers
  const tc = card.querySelector('#thumbnail-container, ytd-thumbnail, a#thumbnail');
  if (tc) return tc;

  // 3. Find any anchor inside card that wraps a thumbnail image
  for (const a of card.querySelectorAll('a')) {
    if (a.querySelector('img, yt-image, picture')) return a;
  }

  // 4. If card is or contains a lockup host div, find its thumbnail anchor
  const lockupHost = card.classList?.contains('ytLockupViewModelHost')
    ? card
    : card.querySelector('.ytLockupViewModelHost, [class*="LockupViewModelHost"]');
  if (lockupHost) {
    const firstLink = lockupHost.querySelector('a');
    if (firstLink) return firstLink;
    return lockupHost;
  }

  // 5. Any image in the card -> its wrapping link or parent
  const img = card.querySelector('img[src*="ytimg"], img[src*="i.ytimg"], img');
  if (img) return img.closest('a') || img.parentElement;

  // 6. Fallback: any element with thumbnail in class name
  return card.querySelector('[class*="thumbnail"], [class*="Thumbnail"]');
}

/* ── create the download button on a thumbnail ────────────────────────── */

function injectButton(thumbEl, videoId, card) {
  if (thumbEl.querySelector('.ydl-thumb-btn')) return; // already injected

  // Make sure thumbnail is positioned so our button can float inside it
  const cs = getComputedStyle(thumbEl);
  if (cs.position === 'static') thumbEl.style.position = 'relative';

  const btn = document.createElement('button');
  btn.className = 'ydl-thumb-btn';
  btn.setAttribute('data-video-id', videoId);
  btn.innerHTML = '⬇';
  btn.title = 'Download with youDl';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    toggleThumbPanel(btn, videoId, card);
  });

  // Prevent navigation when clicking the button
  btn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
  btn.addEventListener('mouseup', (e) => { e.stopPropagation(); });

  thumbEl.appendChild(btn);
  log('injected button for', videoId);
}

/* ── mini quality/format panel ────────────────────────────────────────── */

function closeActivePanel() {
  if (activePanel) {
    activePanel.remove();
    activePanel = null;
  }
  if (activePanelCard) {
    const btn = activePanelCard.querySelector('.ydl-thumb-btn');
    if (btn) btn.classList.remove('ydl-visible');
    activePanelCard = null;
  }
}

function toggleThumbPanel(btn, videoId, card) {
  // If this panel is already open, close it
  if (activePanel && activePanelCard === card) {
    closeActivePanel();
    return;
  }
  closeActivePanel();
  openThumbPanel(btn, videoId, card);
}

function openThumbPanel(btn, videoId, card) {
  const title = extractTitle(card) || videoId;

  btn.classList.add('ydl-visible');
  activePanelCard = card;

  const panel = document.createElement('div');
  panel.className = 'ydl-thumb-panel';
  activePanel = panel;

  // Title
  const titleEl = document.createElement('div');
  titleEl.className = 'ydl-tp-title';
  titleEl.textContent = title;
  titleEl.title = title;
  panel.appendChild(titleEl);

  // Format row
  const fmtRow = document.createElement('div');
  fmtRow.className = 'ydl-tp-fmt-row';
  FORMATS.forEach((f) => {
    const fb = document.createElement('button');
    fb.className = 'ydl-tp-fmt' + (selectedFormat === f.id ? ' active' : '');
    fb.textContent = f.label;
    fb.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedFormat = f.id;
      closeActivePanel();
      openThumbPanel(btn, videoId, card);
    });
    fmtRow.appendChild(fb);
  });
  panel.appendChild(fmtRow);

  // Quality buttons
  if (selectedFormat === 'mp3') {
    const qb = document.createElement('button');
    qb.className = 'ydl-tp-q';
    qb.textContent = 'Download MP3 Audio';
    qb.addEventListener('click', (e) => {
      e.stopPropagation();
      startThumbDownload(btn, videoId, 'audio', 'mp3', title);
    });
    panel.appendChild(qb);
  } else {
    for (const p of PRESETS) {
      if (p.value === 'audio' && selectedFormat !== 'mp3') continue;
      const qb = document.createElement('button');
      qb.className = 'ydl-tp-q';
      qb.textContent = p.label;
      qb.addEventListener('click', (e) => {
        e.stopPropagation();
        startThumbDownload(btn, videoId, p.value, selectedFormat, title);
      });
      panel.appendChild(qb);
    }
  }

  // Append to body so it escapes any overflow:hidden ancestors
  document.body.appendChild(panel);

  // Position relative to the button using fixed coordinates
  requestAnimationFrame(() => {
    const btnRect = btn.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelH = panelRect.height;
    const panelW = panelRect.width;

    // Default: show above the button, right-aligned to its right edge
    let top = btnRect.top - panelH - 6;
    let left = btnRect.right - panelW;

    // If it would go above viewport, show below button instead
    if (top < 4) {
      top = btnRect.bottom + 6;
    }
    // If it goes off the right edge, align to left edge of button
    if (left + panelW > window.innerWidth - 4) {
      left = btnRect.left;
    }
    // If it goes off the left edge, push right
    if (left < 4) {
      left = 4;
    }

    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  });
}

async function startThumbDownload(btn, videoId, preset, format, title) {
  closeActivePanel();

  // Turn button into a progress indicator
  btn.classList.add('ydl-downloading');
  btn.innerHTML = `
    <svg class="ydl-ring-svg" viewBox="0 0 30 30">
      <circle class="ydl-ring-bg" cx="15" cy="15" r="12"/>
      <circle class="ydl-ring-fg" cx="15" cy="15" r="12"
              stroke-dasharray="75.4" stroke-dashoffset="75.4"/>
    </svg>
    <span style="font-size:9px;z-index:1;position:relative;">0%</span>
  `;

  try {
    const data = await postJob(videoId, preset, format, title);
    if (data && data.jobId) {
      pollThumbProgress(btn, data.jobId, videoId);
    }
  } catch (e) {
    btn.classList.remove('ydl-downloading');
    btn.innerHTML = '⬇';
    btn.title = `Error: ${e.message}`;
    console.warn('[youDl:thumbs] download start error:', e);
  }
}

function pollThumbProgress(btn, jobId, videoId) {
  const circle = btn.querySelector('.ydl-ring-fg');
  const label = btn.querySelector('span');
  const circumference = 2 * Math.PI * 12; // ~75.4

  const timer = setInterval(async () => {
    if (dead || !btn.isConnected) { clearInterval(timer); return; }

    const resp = await bgSend({ type: 'YDL_JOBS_GET', videoId });
    if (!resp || !resp.ok) return;

    const job = (resp.jobs || []).find((j) => j.jobId === jobId);
    if (!job) return;

    const s = job.snapshot || {};
    const pct = (s.progress && s.progress.pct) || 0;

    if (circle) {
      const offset = circumference - (circumference * pct / 100);
      circle.setAttribute('stroke-dashoffset', offset);
    }
    if (label) {
      if (s.status === 'postprocessing') label.textContent = '⏳';
      else if (s.status === 'done') label.textContent = '✓';
      else if (s.status === 'error') label.textContent = '✗';
      else label.textContent = `${pct}%`;
    }

    if (['done', 'error', 'canceled'].includes(s.status)) {
      clearInterval(timer);
      setTimeout(() => {
        btn.classList.remove('ydl-downloading');
        btn.innerHTML = '⬇';
        btn.title = s.status === 'done' ? 'Download complete!' : 'Download with youDl';
      }, s.status === 'done' ? 2000 : 500);
    }
  }, 800);
}

/* ── thumbnail scanner ────────────────────────────────────────────────── */

// All the YouTube custom elements that represent a video card
const CARD_SELECTORS = [
  'ytd-rich-item-renderer',            // home page grid
  'ytd-video-renderer',                // search results
  'ytd-compact-video-renderer',        // sidebar / related (old layout)
  'ytd-compact-playlist-renderer',     // sidebar playlist
  'ytd-compact-radio-renderer',        // sidebar mix
  'ytd-grid-video-renderer',           // channel video grid
  'ytd-playlist-video-renderer',       // playlist items
  'ytd-reel-item-renderer',            // Shorts shelf
  'ytd-rich-grid-media',               // home page (alternate)
  'ytd-playlist-panel-video-renderer', // mini-player playlist
  'yt-lockup-view-model',              // NEW: sidebar, home, search (2025+ layout)
  'yt-compact-video-view-model',       // NEW: sidebar compact variant
].join(',');

// Process a single candidate card — returns true if button was injected
function processCard(card) {
  if (dead) return false;
  if (card.querySelector('.ydl-thumb-btn')) return false;

  // If this is a lockup-view-model nested inside an already-processed
  // parent card (e.g. ytd-rich-item-renderer on home page), skip it
  if (card.tagName === 'YT-LOCKUP-VIEW-MODEL' || card.tagName === 'YT-COMPACT-VIDEO-VIEW-MODEL') {
    const parentCard = card.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer');
    if (parentCard && parentCard.querySelector('.ydl-thumb-btn')) {
      card.setAttribute(MARKER, 'parent-handled');
      return false;
    }
  }

  // Skip ad slots immediately
  if (card.querySelector('ytd-ad-slot-renderer, [class*="ad-slot"], [id*="ad-slot"]') ||
      card.classList?.contains('ytd-in-feed-ad-layout-renderer')) {
    card.setAttribute(MARKER, 'ad');
    return false;
  }

  // Find a link to extract the video ID
  let videoId = null;

  // Strategy 1: direct a#thumbnail link
  const thumbLink = card.querySelector('a#thumbnail[href]');
  if (thumbLink) videoId = extractVideoId(thumbLink.href || thumbLink.getAttribute('href'));

  // Strategy 2: any anchor with /watch? or /shorts/
  if (!videoId) {
    const links = card.querySelectorAll('a[href*="/watch?"], a[href*="/shorts/"]');
    for (const link of links) {
      videoId = extractVideoId(link.href || link.getAttribute('href'));
      if (videoId) break;
    }
  }

  // Strategy 3: any anchor with an href attribute
  if (!videoId) {
    const anchors = card.querySelectorAll('a[href]');
    for (const a of anchors) {
      videoId = extractVideoId(a.href || a.getAttribute('href'));
      if (videoId) break;
    }
  }

  if (!videoId) {
    // Increment attempt counter; don't permanently blacklist immediately in case DOM is still loading
    const attempts = (parseInt(card.getAttribute('data-ydl-attempts') || '0', 10) || 0) + 1;
    card.setAttribute('data-ydl-attempts', String(attempts));
    if (attempts >= 4) card.setAttribute(MARKER, 'no-video');
    return false;
  }

  // Find the thumbnail container
  const thumbEl = findThumbContainer(card);
  if (!thumbEl) {
    const attempts = (parseInt(card.getAttribute('data-ydl-attempts') || '0', 10) || 0) + 1;
    card.setAttribute('data-ydl-attempts', String(attempts));
    if (attempts >= 4) card.setAttribute(MARKER, 'no-thumb');
    return false;
  }

  card.setAttribute(MARKER, videoId);
  card.removeAttribute('data-ydl-attempts');
  injectButton(thumbEl, videoId, card);
  return true;
}

function scanThumbnails() {
  if (dead) return 0;
  injectMastheadButton();

  const cards = document.querySelectorAll(CARD_SELECTORS);

  let injected = 0;
  for (const card of cards) {
    if (card.querySelector('.ydl-thumb-btn')) continue;
    if (card.getAttribute(MARKER) === 'ad') continue;
    if (card.getAttribute(MARKER) === 'no-video' && !card.querySelector('a[href*="/watch?"], a[href*="/shorts/"]')) continue;

    if (processCard(card)) injected++;
  }
  if (injected > 0) log('injected', injected, 'new buttons (scanned', cards.length, 'cards)');
  return injected;
}

/* ── manual rescan & masthead button ──────────────────────────────────── */

function forceRescan(showToast = true) {
  if (dead) return { injected: 0, total: 0 };

  // Clear stale attempt counters and non-video markers so everything is re-evaluated
  const stale = document.querySelectorAll(`[data-ydl-attempts], [${MARKER}="no-video"], [${MARKER}="no-thumb"], [${MARKER}="parent-handled"]`);
  stale.forEach((el) => {
    el.removeAttribute(MARKER);
    el.removeAttribute('data-ydl-attempts');
  });

  // Re-verify existing marked cards whose button may have been detached by YT
  const existing = document.querySelectorAll(`[${MARKER}]`);
  existing.forEach((el) => {
    if (!el.querySelector('.ydl-thumb-btn')) {
      el.removeAttribute(MARKER);
    }
  });

  const injected = scanThumbnails();
  const total = document.querySelectorAll('.ydl-thumb-btn').length;

  if (showToast) {
    showScanToast(`✓ ${total} download buttons ready`);
  }

  return { injected, total };
}
window.__ydl_rescan = forceRescan;

function showScanToast(msg) {
  let toast = document.getElementById('ydl-scan-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ydl-scan-toast';
    toast.className = 'ydl-scan-toast';
    document.documentElement.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('ydl-toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('ydl-toast-show');
  }, 2200);
}

function injectMastheadButton() {
  if (dead || document.getElementById('ydl-masthead-btn')) return;

  const target = document.querySelector('#masthead #end #buttons') ||
                 document.querySelector('#masthead #end') ||
                 document.querySelector('#masthead');
  if (!target) return;

  const btn = document.createElement('button');
  btn.id = 'ydl-masthead-btn';
  btn.className = 'ydl-masthead-btn';
  btn.type = 'button';
  btn.title = 'youDl: Scan & inject download buttons on this page without refreshing (Alt+D)';
  btn.innerHTML = '<span class="ydl-mb-icon">⬇</span><span>youDl Scan</span>';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.add('spinning');
    forceRescan(true);
    setTimeout(() => btn.classList.remove('spinning'), 500);
  });

  if (target.firstChild) {
    target.insertBefore(btn, target.firstChild);
  } else {
    target.appendChild(btn);
  }
}

// On-demand injection when hovering over any video card
document.addEventListener('mouseover', (e) => {
  if (dead) return;
  const target = e.target;
  if (!target || !target.closest) return;
  const card = target.closest(CARD_SELECTORS);
  if (card && !card.querySelector('.ydl-thumb-btn')) {
    processCard(card);
  }
}, { passive: true });

// Keyboard shortcut Alt+D to force rescan
document.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    forceRescan(true);
  }
});

// Listen for popup force-rescan requests
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'YDL_FORCE_RESCAN') {
    const res = forceRescan(true);
    sendResponse({ ok: true, ...res });
  }
});

/* ── close panel on outside click ─────────────────────────────────────── */

document.addEventListener('click', (e) => {
  if (!activePanel) return;
  if (activePanel.contains(e.target)) return;
  // Check if clicking another download button (that one will handle open/close)
  if (e.target.closest('.ydl-thumb-btn')) return;
  closeActivePanel();
}, true);

// Close panel on scroll to avoid misaligned panels
let scrollCloseTimer = null;
window.addEventListener('scroll', () => {
  if (!activePanel) return;
  if (scrollCloseTimer) clearTimeout(scrollCloseTimer);
  scrollCloseTimer = setTimeout(closeActivePanel, 150);
}, true);

// Close on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeActivePanel();
});

/* ── MutationObserver for dynamic YouTube content ─────────────────────── */

// YouTube is an SPA; thumbnails are loaded dynamically.
// Use a MutationObserver to catch new thumbnails as they appear.

const observer = new MutationObserver((mutations) => {
  if (dead) return;
  // Debounce scans — YouTube often adds many nodes in quick succession
  if (observer._scanTimer) return;
  observer._scanTimer = setTimeout(() => {
    observer._scanTimer = null;
    scanThumbnails();
  }, 300);
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

// Also re-scan on SPA navigation
window.addEventListener('yt-navigate-finish', () => {
  log('yt-navigate-finish');
  setTimeout(scanThumbnails, 400);
  setTimeout(scanThumbnails, 1200);
  setTimeout(scanThumbnails, 3000);
});
window.addEventListener('popstate', () => {
  log('popstate');
  setTimeout(scanThumbnails, 400);
  setTimeout(scanThumbnails, 1200);
});

// Scroll-triggered re-scan for infinite-scroll pages
let scrollScanTimer = null;
window.addEventListener('scroll', () => {
  if (scrollScanTimer) clearTimeout(scrollScanTimer);
  scrollScanTimer = setTimeout(scanThumbnails, 400);
}, { passive: true });

// Initial scan — run multiple times as YouTube lazy-renders content
setTimeout(scanThumbnails, 300);
setTimeout(scanThumbnails, 1000);
setTimeout(scanThumbnails, 2500);
setTimeout(scanThumbnails, 5000);

log('thumbnail scanner initialized');
})();
