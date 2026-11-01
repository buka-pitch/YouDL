/**
 * youDl — in-memory job store.
 * Deliberately stateless across restarts: a local helper that forgets its
 * history when you close it is a feature, not a bug.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const yt = require('./yt');

const MAX_CONCURRENT = 2;

const jobs = new Map(); // id -> job
const queue = [];       // job ids waiting for a slot
let active = 0;
let nextId = Math.floor(Date.now() / 1000);

/** Working output directory: temp cache (overridable per job or via YOUDL_OUTPUT).
 * Browser download manager saves the final copy to user's chosen folder.
 */
function outputDir(requested) {
  const dir = requested ||
    process.env.YOUDL_OUTPUT ||
    path.join(os.tmpdir(), 'youDl');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizePreset(preset) {
  const p = String(preset || 'best').toLowerCase();
  return yt.PRESETS[p] ? p : (yt.formatSelector(p) !== 'best' ? p : 'best');
}

function sanitizeFormat(fmt) {
  const f = String(fmt || 'mp4').toLowerCase().trim();
  if (['mp4', 'webm', 'mkv', 'mp3'].includes(f)) return f;
  return 'mp4';
}

function snapshot(job) {
  return {
    jobId: job.id,
    url: job.url,
    title: job.title || null,
    preset: job.preset,
    format: job.format,
    status: job.status, // queued | downloading | postprocessing | done | error | canceled
    progress: job.progress,
    filepath: job.filepath,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/** Fire a job's yt-dlp process if a slot is free. */
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = jobs.get(queue.shift());
    if (!job || job.status !== 'queued') continue;
    active++;
    launch(job);
  }
}

function launch(job) {
  job.status = 'downloading';
  const proc = yt.startDownload(
    job.url,
    {
      format: yt.formatSelector(job.preset),
      formatType: job.format,
      output: job.outputDir,
    },
    {
      onProgress: (prog) => {
        if (typeof prog === 'object' && prog !== null) {
          job.progress = {
            pct: prog.pct,
            bytes: prog.downloaded || 0,
            total: prog.total || 0,
            speed: prog.speed || '',
            eta: prog.eta || '',
            stage: prog.stage || 'downloading',
          };
          if (prog.stage === 'merging') job.status = 'postprocessing';
        } else {
          job.progress = {
            pct: Math.round(prog),
            bytes: 0,
            total: 0,
            speed: '',
            eta: '',
            stage: 'downloading',
          };
        }
      },
      onDone: (filepath) => {
        if (filepath) job.filepath = filepath;
      },
      onError: (message) => {
        job.error = message;
      },
    }
  );

  job.proc = proc;

  proc.on('close', (code) => {
    active--;
    job.proc = null;
    if (job.status === 'canceled') {
      // already marked
    } else if (code === 0 && job.filepath) {
      job.status = 'done';
      job.progress.pct = 100;
      job.finishedAt = Date.now();
    } else if (code === 0 && !job.filepath) {
      // Merged without --print output (older yt-dlp): try inferring? keep error-free best effort.
      job.status = 'done';
      job.progress.pct = 100;
      job.finishedAt = Date.now();
      job.error = null;
    } else {
      job.status = 'error';
      job.finishedAt = Date.now();
    }
    pump();
  });
}

function create({ url, title, preset = 'best', format = 'mp4', output }) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('A valid http(s) URL is required.');
  }
  const job = {
    id: nextId++,
    url,
    title: title ? String(title).trim() : null,
    preset: sanitizePreset(preset),
    format: sanitizeFormat(format),
    outputDir: outputDir(output),
    status: 'queued',
    progress: { pct: 0, bytes: 0, total: 0, speed: '', eta: null, stage: 'queued' },
    filepath: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    proc: null,
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  pump();
  return snapshot(job);
}

function get(id) {
  return jobs.get(id) ? snapshot(jobs.get(id)) : null;
}

function removeCompletedFile(id) {
  const job = jobs.get(Number(id));
  if (!job || job.status !== 'done' || !job.filepath) return false;
  try {
    fs.unlinkSync(job.filepath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  job.filepath = null;
  return true;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'queued') {
    job.status = 'canceled';
    job.finishedAt = Date.now();
    pump(); // drop it from the queue path
    return snapshot(job);
  }
  if (job.status === 'downloading' && job.proc) {
    job.status = 'canceled';
    job.finishedAt = Date.now();
    try { job.proc.kill('SIGTERM'); } catch (_) { /* already gone */ }
  }
  return snapshot(job);
}

function list() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(snapshot);
}

module.exports = { create, get, cancel, list, removeCompletedFile };
