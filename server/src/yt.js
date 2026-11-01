/**
 * youDl — yt-dlp wrapper.
 *
 * Spawns yt-dlp as child processes and turns its stdout/stderr into
 * structured results. Nothing in here knows about HTTP; jobs.js owns state.
 */
'use strict';

const { spawn } = require('child_process');

const YTDLP = process.env.YOUDL_YTDLP_BIN || 'yt-dlp';

// Machine-parseable progress template. yt-dlp prints, on stderr, one line per
// progress tick:
//   YDLPROG|<percent>|<downloaded_bytes>|<total>|<speed>|<eta>
const PROG_TEMPLATE =
  'download:YDLPROG|%(progress._percent_str)s|' +
  '%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress._speed_str)s|%(progress._eta_str)s';

function run(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(err.trim().split('\n').pop() || `yt-dlp exited ${code}`));
    });
  });
}

/** Is the helper installed and healthy? */
async function ping() {
  const { stdout } = await run(['--version'], 8000);
  const version = stdout.trim();
  let ffmpeg = false;
  try {
    await run(['--version'], 4000); // no-op guard
    ffmpeg = await hasFfmpeg();
  } catch (_) { /* non-fatal */ }
  return { version, ffmpeg };
}

async function hasFfmpeg() {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
    setTimeout(() => { p.kill(); resolve(false); }, 5000);
  });
}

function estimateSizes(formats, duration) {
  const getBytes = (f) => {
    if (!f) return 0;
    if (f.filesize) return f.filesize;
    if (f.filesize_approx) return f.filesize_approx;
    if (f.tbr && duration) return Math.round((f.tbr * 1000 / 8) * duration);
    if (f.vbr && duration) return Math.round((f.vbr * 1000 / 8) * duration);
    if (f.abr && duration) return Math.round((f.abr * 1000 / 8) * duration);
    return 0;
  };

  const audioFormats = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  const bestAudio = audioFormats.reduce((best, f) => getBytes(f) > getBytes(best) ? f : best, null);
  const bestAudioBytes = getBytes(bestAudio) || (duration ? Math.round((160 * 1000 / 8) * duration) : 0);

  const getForContainer = (targetContainer) => {
    const isCompat = (f) => {
      if (!targetContainer) return true;
      if (targetContainer === 'webm') return f.ext === 'webm' || (f.vcodec && f.vcodec.startsWith('vp'));
      if (targetContainer === 'mp4') return f.ext === 'mp4' || (f.vcodec && (f.vcodec.startsWith('avc') || f.vcodec.startsWith('av01')));
      return true;
    };

    const heights = [1080, 720, 480, 360];
    const res = {};
    for (const h of heights) {
      let matching = formats.filter(f => f.height && f.height <= h && f.vcodec && f.vcodec !== 'none');
      let filtered = matching.filter(isCompat);
      if (!filtered.length) filtered = matching;
      filtered.sort((a, b) => (b.height || 0) - (a.height || 0) || getBytes(b) - getBytes(a));
      const chosen = filtered[0];
      if (chosen) {
        const vBytes = getBytes(chosen);
        const isMuxed = chosen.acodec && chosen.acodec !== 'none';
        res[h] = isMuxed ? vBytes : (vBytes + bestAudioBytes);
      }
    }

    let allVideos = formats.filter(f => f.vcodec && f.vcodec !== 'none');
    let filteredAll = allVideos.filter(isCompat);
    if (!filteredAll.length) filteredAll = allVideos;
    filteredAll.sort((a, b) => (b.height || 0) - (a.height || 0) || getBytes(b) - getBytes(a));
    const bestVid = filteredAll[0];
    res['best'] = bestVid ? (bestVid.acodec && bestVid.acodec !== 'none' ? getBytes(bestVid) : getBytes(bestVid) + bestAudioBytes) : 0;
    res['audio'] = bestAudioBytes;
    return res;
  };

  return {
    mp4: getForContainer('mp4'),
    webm: getForContainer('webm'),
    mp3: { audio: bestAudioBytes, best: bestAudioBytes },
  };
}

/**
 * Metadata + format inventory for a URL.
 * Returns the trimmed payload the extension actually renders.
 */
async function resolve(url) {
  const { stdout } = await run(
    ['-J', '--no-playlist', '--no-warnings', '--skip-download', url],
    25000
  );
  const info = JSON.parse(stdout);

  const formats = (info.formats || [])
    .filter((f) => f.format_id)
    .map((f) => ({
      format_id: f.format_id,
      height: f.height || null,
      fps: f.fps || null,
      ext: f.ext || null,
      abr: f.abr || null,
      filesize: f.filesize || f.filesize_approx || null,
      note: f.format_note || null,
    }))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  const estimatedSizes = estimateSizes(info.formats || [], info.duration || null);

  return {
    id: info.id,
    title: info.title || info.id,
    uploader: info.uploader || info.channel || null,
    duration: info.duration || null,
    thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length
      ? info.thumbnails[info.thumbnails.length - 1].url : null),
    webpage_url: info.webpage_url || url,
    extractor: info.extractor_key || info.extractor || null,
    is_video: /^(youtube|Youtube)$/.test(info.extractor_key || '') ? 'youtube' : (info.extractor_key || 'other'),
    formats,
    estimatedSizes,
  };
}

/**
 * Spawn a download job. Plugged into jobs.js — receives callbacks so the
 * job store stays independent of yt-dlp's process lifecycle.
 *
 * opts.format  — yt-dlp format selector (preset or explicit format_id)
 * opts.output  — output directory; template ensures predictable file names
 * onProgress(info)
 * onDone(filepath) — from yt-dlp's own "final path" report
 * onError(message)
 * returns the child process (for cancel)
 */
function startDownload(url, opts, { onProgress, onDone, onError }) {
  const formatType = (opts.formatType || 'mp4').toLowerCase();
  const args = ['-f', opts.format];

  if (formatType === 'mp3') {
    args.push('-x', '--audio-format', 'mp3');
  } else if (formatType === 'webm') {
    args.push('--merge-output-format', 'webm');
  } else if (formatType === 'mkv') {
    args.push('--merge-output-format', 'mkv');
  } else {
    // Default to mp4 container:
    // -S ext:mp4:m4a prefers native AAC (m4a) audio and MP4 video streams.
    // --postprocessor-args Merger:-c:v copy -c:a aac guarantees the merged MP4
    // audio track is standard AAC, ensuring 100% sound compatibility on all devices.
    args.push(
      '-S', 'ext:mp4:m4a',
      '--merge-output-format', 'mp4',
      '--postprocessor-args', 'Merger:-c:v copy -c:a aac'
    );
  }

  args.push(
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',                    // progress even though --print implies --quiet
    '--progress-template', PROG_TEMPLATE,
    '--print', 'after_move:filepath',
    '-o', `${opts.output}/%(title)s [%(id)s].%(ext)s`,
    url
  );

  const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdoutBuf = '', stderrBuf = '';
  let streamCount = 0;
  let completedStreamsBytes = 0;
  let lastStreamDownloaded = 0;
  let lastStreamTotal = 0;

  // IMPORTANT: --progress-template lines are written to STDOUT (verified on
  // yt-dlp 2026.10.26), interleaved with the final `--print` filepath.
  proc.stdout.on('data', (d) => {
    stdoutBuf += d;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('YDLPROG|')) { parseProgressLine(line); continue; }
      if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[Fixup')) {
        onProgress({ pct: 99, stage: 'merging', speed: '', eta: '' });
        continue;
      }
      if (line.startsWith('[')) continue;          // [Merger]… style notes
      onDone(line);                                // after_move:filepath
    }
  });

  // stderr: warnings/errors, plus progress lines on yt-dlp versions that
  // emit them there — parse those, never treat stderr as a filepath.
  proc.stderr.on('data', (d) => {
    stderrBuf += d;
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('YDLPROG|')) parseProgressLine(line);
      if (line.includes('[Merger]') || line.includes('[ExtractAudio]') || line.includes('[Fixup')) {
        onProgress({ pct: 99, stage: 'merging', speed: '', eta: '' });
      }
    }
  });

  proc.on('error', (e) => onError(String(e.message || e)));
  proc.on('close', (code) => {
    // flush whatever is still buffered before deciding the outcome
    const tailOut = stdoutBuf.trim();
    stdoutBuf = '';
    if (tailOut && tailOut.startsWith('YDLPROG|')) parseProgressLine(tailOut);
    else if (tailOut && !tailOut.startsWith('[')) onDone(tailOut);
    stderrBuf.split('\n').forEach((l) => parseProgressLine(l.trim()));

    if (code === 0) {
      onProgress({ pct: 100, stage: 'done' });
      onDone(null); // final signal; jobs.js keeps the last valid filepath
    } else {
      const tail = stderrBuf.trim().split('\n').filter(Boolean).pop();
      onError(tail || `yt-dlp exited with code ${code}`);
    }
  });

  function parseProgressLine(line) {
    if (!line.startsWith('YDLPROG|')) return;
    const parts = line.slice('YDLPROG|'.length).split('|');
    if (parts.length < 5) return;

    const rawPct = parseFloat(parts[0]);
    const downloaded = parseFloat(parts[1]) || 0;
    const total = parseFloat(parts[2]) || 0;
    const speed = (parts[3] || '').trim();
    const eta = (parts[4] || '').trim();

    // When the stream downloaded resets, previous stream has completed!
    if (downloaded < lastStreamDownloaded && lastStreamTotal > 0) {
      completedStreamsBytes += lastStreamTotal;
      streamCount++;
    }

    lastStreamDownloaded = downloaded;
    if (total > 0) lastStreamTotal = total;

    const currentTotal = completedStreamsBytes + lastStreamTotal;
    const currentDownloaded = completedStreamsBytes + downloaded;
    let compositePct = currentTotal > 0
      ? Math.min(99, Math.round((currentDownloaded / currentTotal) * 100))
      : (Number.isNaN(rawPct) ? 0 : Math.min(99, Math.round(rawPct)));

    onProgress({
      pct: compositePct,
      downloaded: currentDownloaded,
      total: currentTotal,
      speed,
      eta,
      stage: 'downloading',
    });
  }

  return proc;
}

/** Map UI quality presets to yt-dlp selectors. */
const PRESETS = {
  best: 'bv*+ba/b',
  1080: 'bv*[height<=1080]+ba/b[height<=1080]/b',
  720: 'bv*[height<=720]+ba/b[height<=720]/b',
  480: 'bv*[height<=480]+ba/b[height<=480]/b',
  360: 'bv*[height<=360]+ba/b[height<=360]/b',
  audio: 'ba/b',
};

function formatSelector(presetOrId) {
  if (PRESETS[presetOrId]) return PRESETS[presetOrId];
  // Explicit format_id passes straight through; append /b fallback.
  return /^[a-zA-Z0-9+-]+$/.test(String(presetOrId)) ? `${presetOrId}/b` : 'best';
}

module.exports = { ping, resolve, startDownload, formatSelector, PRESETS };
