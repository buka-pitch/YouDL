/**
 * youDl popup controller.
 *
 * Flow: helper ping → detected tab video (or paste) → /resolve →
 * quality pick → background YDL_API (/jobs) → live progress → done path.
 *
 * State model: the background worker registers and polls every job;
 * this popup renders both the active video job and the complete
 * Download Queue & History panel.
 */
'use strict';

const API = 'http://127.0.0.1:8765';
const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  helperOk: false,
  ffmpeg: false,
  videoUrl: null,
  poll: null,          // setInterval handle for view rendering
  estimatedSizes: null,
};

/* ── helpers ─────────────────────────────────────────────────────────── */

function show(el, yes = true) {
  if (el) el.classList.toggle('hidden', !yes);
}

function setStatus(text, { error = false, loading = false } = {}) {
  const line = $('status-line');
  const txt = $('status-text');
  const spinner = $('status-spinner');
  if (txt) txt.textContent = text;
  if (line) line.classList.toggle('muted', !error);
  show(spinner, loading);
}

function setDot(ok) {
  $('srv-dot').className = 'dot ' + (ok ? 'ok' : 'err');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!n || isNaN(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function videoIdOf(url) {
  const m = String(url || '').match(/\/watch\?[^#]*\b(v|video_id)=([A-Za-z0-9_-]{6,})/)
      || String(url || '').match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
  return m ? (m[2] || m[1]) : null;
}

/** Proxy requests through background service worker so jobs are tracked centrally */
function bgApi(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'YDL_API', path, method, body }, (resp) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!resp || resp.ok === false) {
        return reject(new Error(resp?.error || 'helper error'));
      }
      resolve(resp.data);
    });
  });
}

function fetchAllJobs() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'YDL_JOBS_GET' }, (resp) => {
      void chrome.runtime.lastError;
      resolve((resp && resp.jobs) || []);
    });
  });
}

function updateEstSize() {
  if (!state.estimatedSizes) {
    $('est-size-val').textContent = '—';
    return;
  }
  const fmt = $('format').value || 'mp4';
  const preset = $('quality').value || 'best';
  const sz = (state.estimatedSizes[fmt] && state.estimatedSizes[fmt][preset])
    || (state.estimatedSizes.mp4 && state.estimatedSizes.mp4[preset]);
  $('est-size-val').textContent = sz ? `~${fmtBytes(sz)}` : 'variable';
}

/* ── startup ─────────────────────────────────────────────────────────── */

(async function init() {
  try {
    const ping = await fetch(API + '/ping').then((r) => r.json());
    if (!ping.ok) throw new Error(ping.error || 'helper not ready');
    state.token = ping.token;
    state.helperOk = true;
    state.ffmpeg = !!ping.ffmpeg;
    setDot(true);
    setStatus(`helper ready · yt-dlp ${ping.version} · ffmpeg ${ping.ffmpeg ? 'found' : 'missing'}`);
    show($('ffmpeg-warn'), !state.ffmpeg);
  } catch (e) {
    setDot(false);
    setStatus('Helper is not running. Start it:  cd server && npm start', { error: true });
    return;
  }

  // Restore saveAs preference
  chrome.storage.local.get('ydlSaveAs', (res) => {
    if (res && res.ydlSaveAs !== undefined) {
      $('saveas-check').checked = !!res.ydlSaveAs;
    }
  });

  await loadTabVideo();
  // While popup is open, poll all jobs and render sidebar + queue/history
  await renderAllJobs();
  state.poll = setInterval(renderAllJobs, 800);
})();

/* ── tab detection ───────────────────────────────────────────────────── */

function loadTabVideo() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'YDL_GET_TAB_VIDEO' }, (resp) => {
      if (resp && resp.url) {
        $('detected-url').textContent = resp.url;
        show($('detected'), true);
        resolveUrl(resp.url);
      } else {
        show($('detected'), false);
        $('url').focus();
      }
      resolve();
    });
  });
}

/* ── resolve ─────────────────────────────────────────────────────────── */

async function resolveUrl(url) {
  if (!state.helperOk) return;
  if (!/^https?:\/\//i.test((url || '').trim())) {
    setStatus('That does not look like a URL.', { error: true });
    return;
  }
  state.videoUrl = url.trim();
  setStatus('Fetching video information…', { loading: true });
  $('go').disabled = true;
  show($('video-card'), false);
  show($('skeleton-card'), true);

  await renderAllJobs();

  try {
    const info = await bgApi('/resolve', 'POST', { url: state.videoUrl });
    state.estimatedSizes = info.estimatedSizes || null;
    $('thumb').src = info.thumbnail || '';
    $('v-title').textContent = info.title;
    const mins = info.duration ? `${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, '0')}` : '';
    $('v-meta').textContent = [info.uploader, mins, `${info.formats.length} formats`].filter(Boolean).join(' · ');
    updateEstSize();
    show($('video-card'), true);
    setStatus('');
  } catch (e) {
    setStatus(e.message, { error: true });
  } finally {
    $('go').disabled = false;
    show($('skeleton-card'), false);
  }
}

$('paste-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  resolveUrl($('url').value);
});

/* ── queue & history rendering ───────────────────────────────────────── */

async function renderAllJobs() {
  const jobs = await fetchAllJobs();

  const queueJobs = [];
  const historyJobs = [];

  for (const j of jobs) {
    const status = (j.snapshot && j.snapshot.status) || 'queued';
    if (['queued', 'downloading', 'postprocessing'].includes(status)) {
      queueJobs.push(j);
    } else {
      historyJobs.push(j);
    }
  }

  // Update badges
  $('badge-queue').textContent = queueJobs.length;
  $('badge-history').textContent = historyJobs.length;

  renderQueueList(queueJobs);
  renderHistoryList(historyJobs);
  renderActiveJob(jobs);
}

function renderQueueList(queueJobs) {
  const listEl = $('queue-list');
  const emptyEl = $('queue-empty');

  if (!queueJobs.length) {
    show(emptyEl, true);
    listEl.innerHTML = '';
    return;
  }
  show(emptyEl, false);

  listEl.innerHTML = queueJobs.map((j) => {
    const s = j.snapshot || {};
    const p = s.progress || {};
    const pct = p.pct || 0;
    const title = escapeHtml(j.title || s.title || j.videoId || `Job #${j.jobId}`);
    const preset = j.preset || s.preset || 'best';
    const fmt = j.format || s.format || 'mp4';
    const statusLabel = s.status === 'postprocessing' ? 'merging…' : (s.status === 'downloading' ? `${pct}%` : 'queued');
    const bytesText = p.bytes ? ` · ${fmtBytes(p.bytes)}${p.total ? ` / ${fmtBytes(p.total)}` : ''}` : '';
    const speedText = p.speed ? ` · ${p.speed}` : '';
    const etaText = p.eta && p.eta !== 'Unknown' ? ` · ETA ${p.eta}` : '';

    return `
      <div class="task-card" data-job="${j.jobId}">
        <div class="task-top">
          <div class="task-title" title="${title}">${title}</div>
          <div class="task-badges">
            <span class="tag-badge tag-fmt">${fmt.toUpperCase()}</span>
            <span class="tag-badge">${preset}</span>
          </div>
        </div>
        <div class="task-mini-bar">
          <div class="task-mini-fill" style="width: ${pct}%"></div>
        </div>
        <div class="task-status-row">
          <span class="task-status-badge">
            <span class="task-dot active"></span>
            <span>${statusLabel}${bytesText}${speedText}${etaText}</span>
          </span>
          <div class="task-actions">
            <button class="task-action-btn btn-cancel" data-action="cancel" data-id="${j.jobId}">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-action="cancel"]').forEach((btn) => {
    btn.onclick = () => cancelJob(Number(btn.dataset.id));
  });
}

function renderHistoryList(historyJobs) {
  const listEl = $('history-list');
  const emptyEl = $('history-empty');

  if (!historyJobs.length) {
    show(emptyEl, true);
    listEl.innerHTML = '';
    return;
  }
  show(emptyEl, false);

  listEl.innerHTML = historyJobs.map((j) => {
    const s = j.snapshot || {};
    const title = escapeHtml(j.title || s.title || j.videoId || `Job #${j.jobId}`);
    const preset = j.preset || s.preset || 'best';
    const fmt = j.format || s.format || 'mp4';
    const status = s.status;
    const isDone = status === 'done';
    const dotClass = isDone ? 'done' : 'err';
    const statusLabel = isDone ? 'Saved ✓' : (status === 'canceled' ? 'Canceled' : 'Failed');
    const bytesText = s.progress?.total ? ` · ${fmtBytes(s.progress.total)}` : '';
    const fileBase = s.filepath ? s.filepath.split(/[/\\]/).pop() : '';

    return `
      <div class="task-card" data-job="${j.jobId}">
        <div class="task-top">
          <div class="task-title" title="${title}">${title}</div>
          <div class="task-badges">
            <span class="tag-badge tag-fmt">${fmt.toUpperCase()}</span>
            <span class="tag-badge">${preset}</span>
          </div>
        </div>
        <div class="task-status-row">
          <span class="task-status-badge">
            <span class="task-dot ${dotClass}"></span>
            <span>${statusLabel}${bytesText}</span>
          </span>
          <div class="task-actions">
            ${isDone ? `<button class="task-action-btn btn-download" data-action="save" data-id="${j.jobId}" data-file="${escapeHtml(fileBase)}">Save As</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-action="save"]').forEach((btn) => {
    btn.onclick = () => {
      const jobId = btn.dataset.id;
      const file = btn.dataset.file;
      chrome.downloads.download({
        url: `${API}/jobs/${jobId}/file`,
        filename: file || undefined,
        saveAs: true,
      });
    };
  });
}

function renderActiveJob(allJobs) {
  const vid = videoIdOf(state.videoUrl);
  // Match current video's job or fallback to active job
  const j = allJobs.find((item) => vid && item.videoId === vid)
    || allJobs.find((item) => ['queued', 'downloading', 'postprocessing'].includes((item.snapshot || {}).status));

  if (!j) {
    show($('job'), false);
    return;
  }

  const s = j.snapshot || {};
  const p = s.progress || {};

  show($('job'), true);
  $('bar-fill').style.width = (p.pct || 0) + '%';
  const bytes = p.bytes ? ` (${fmtBytes(p.bytes)}${p.total ? ` / ${fmtBytes(p.total)}` : ''})` : '';
  let label = s.status;
  if (s.status === 'downloading') label = `downloading ${p.pct || 0}%${bytes}`;
  else if (s.status === 'postprocessing') label = `merging streams… 99%`;
  else if (s.status === 'queued') label = 'queued…';
  else if (s.status === 'done') label = 'done ✓ (saved)';
  else if (s.status === 'error') label = 'failed ✗';
  else if (s.status === 'canceled') label = 'canceled';
  $('job-status').textContent = label;

  $('job-speed').textContent = p.speed ? `${p.speed}` : '';
  $('job-eta').textContent = p.eta && p.eta !== 'Unknown' ? `ETA: ${p.eta}` : '';

  $('cancel').disabled = !['queued', 'downloading', 'postprocessing'].includes(s.status);
  $('cancel').onclick = () => cancelJob(j.jobId);
  if (s.filepath) $('file-path').textContent = s.filepath;
  if (s.error) setStatus(s.error, { error: true });
}

async function cancelJob(jobId) {
  try {
    await bgApi(`/jobs/${jobId}/cancel`, 'POST', {});
    await renderAllJobs();
  } catch (e) {
    console.warn('[youDl] cancel error:', e);
  }
}

/* ── download & settings listeners ───────────────────────────────────── */

$('saveas-check').addEventListener('change', () => {
  chrome.storage.local.set({ ydlSaveAs: $('saveas-check').checked });
});

$('format').addEventListener('change', () => {
  if ($('format').value === 'mp3') {
    $('quality').value = 'audio';
  } else if ($('quality').value === 'audio') {
    $('quality').value = 'best';
  }
  updateEstSize();
});

$('quality').addEventListener('change', () => {
  if ($('quality').value === 'audio' && $('format').value !== 'mp3') {
    $('format').value = 'mp3';
  } else if ($('quality').value !== 'audio' && $('format').value === 'mp3') {
    $('format').value = 'mp4';
  }
  updateEstSize();
});

$('dl').addEventListener('click', async () => {
  if (!state.videoUrl) return;
  const preset = $('quality').value;
  const format = $('format').value;
  const title = $('v-title').textContent || null;
  $('dl').disabled = true;
  try {
    await bgApi('/jobs', 'POST', { url: state.videoUrl, title, preset, format });
    await renderAllJobs();
  } catch (e) {
    setStatus(e.message, { error: true });
  } finally {
    $('dl').disabled = false;
  }
});

/* ── tabs & history clear ────────────────────────────────────────────── */

$('tab-queue').addEventListener('click', () => {
  $('tab-queue').classList.add('active');
  $('tab-history').classList.remove('active');
  show($('view-queue'), true);
  show($('view-history'), false);
});

$('tab-history').addEventListener('click', () => {
  $('tab-history').classList.add('active');
  $('tab-queue').classList.remove('active');
  show($('view-history'), true);
  show($('view-queue'), false);
});

$('clear-history').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'YDL_CLEAR_HISTORY' }, () => {
    renderAllJobs();
  });
});

/* ── manual scan / inject active tab ──────────────────────────────────── */

const scanBtn = $('btn-scan-tab');
if (scanBtn) {
  scanBtn.addEventListener('click', () => {
    scanBtn.classList.add('scanning');
    scanBtn.textContent = '⏳ Scanning…';

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) {
        scanBtn.textContent = '✗ No Tab';
        setTimeout(() => { scanBtn.classList.remove('scanning'); scanBtn.textContent = 'Scan Page'; }, 1500);
        return;
      }

      if (!tab.url || !/(^|\.)youtube\.com\//i.test(tab.url)) {
        scanBtn.textContent = '✗ Not YouTube';
        setTimeout(() => { scanBtn.classList.remove('scanning'); scanBtn.textContent = 'Scan Page'; }, 1500);
        return;
      }

      // Try sending a message to the running content script
      chrome.tabs.sendMessage(tab.id, { type: 'YDL_FORCE_RESCAN' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // Script not running or context invalidated — inject dynamically via scripting API!
          if (chrome.scripting && chrome.scripting.executeScript) {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content/sniffer.js', 'content/overlay.js', 'content/thumbs.js'],
            }).then(() => {
              scanBtn.textContent = '✓ Injected!';
            }).catch((err) => {
              console.warn('[youDl] executeScript error:', err);
              scanBtn.textContent = '✗ Error';
            }).finally(() => {
              setTimeout(() => {
                scanBtn.classList.remove('scanning');
                scanBtn.textContent = 'Scan Page';
              }, 2000);
            });
          } else {
            scanBtn.textContent = '✗ Refresh Tab';
            setTimeout(() => {
              scanBtn.classList.remove('scanning');
              scanBtn.textContent = 'Scan Page';
            }, 2000);
          }
        } else {
          scanBtn.textContent = `✓ ${resp.total !== undefined ? resp.total : (resp.injected || 0)} Ready!`;
          setTimeout(() => {
            scanBtn.classList.remove('scanning');
            scanBtn.textContent = 'Scan Page';
          }, 2000);
        }
      });
    });
  });
}

