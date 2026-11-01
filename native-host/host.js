#!/usr/bin/env node
/**
 * youDl Native Messaging Host.
 *
 * Communicates with Chrome, Brave, Edge, and Firefox via length-prefixed
 * JSON packets on stdin / stdout.
 *
 * Spawns and manages yt-dlp through the core youDl server modules,
 * requiring zero open HTTP ports, zero localhost firewall rules, and
 * zero manual server startup.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');

// Redirect stdout-based console calls to stderr so stdout is strictly preserved for binary JSON frames
console.log = (...args) => console.error('[youDl:native]', ...args);
console.info = (...args) => console.error('[youDl:native]', ...args);

const yt = require(path.join(__dirname, '..', 'server', 'src', 'yt.js'));
const jobs = require(path.join(__dirname, '..', 'server', 'src', 'jobs.js'));

/* ── length-prefixed stdio messaging ──────────────────────────────────── */

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + msgLen) {
      break; // Wait for the remaining bytes
    }

    const msgBytes = inputBuffer.slice(4, 4 + msgLen);
    inputBuffer = inputBuffer.slice(4 + msgLen);

    try {
      const msg = JSON.parse(msgBytes.toString('utf8'));
      handleMessage(msg);
    } catch (err) {
      console.error('[youDl:native] Error parsing JSON message:', err);
    }
  }
});

process.stdin.on('end', () => {
  console.error('[youDl:native] stdin EOF — host exiting');
  process.exit(0);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

function sendMsg(obj) {
  try {
    const jsonStr = JSON.stringify(obj);
    const jsonBuf = Buffer.from(jsonStr, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(jsonBuf.length, 0);
    process.stdout.write(Buffer.concat([lenBuf, jsonBuf]));
  } catch (err) {
    console.error('[youDl:native] Error sending message:', err);
  }
}

/* ── active job progress broadcaster ─────────────────────────────────── */

let broadcastTimer = null;

function ensureJobBroadcasting() {
  if (broadcastTimer) return;
  broadcastTimer = setInterval(() => {
    const all = jobs.list();
    const active = all.filter((j) => ['queued', 'downloading', 'postprocessing'].includes(j.status));

    // Send the terminal snapshot before stopping so the extension can notify
    // the browser download manager and open its normal save prompt.
    sendMsg({ event: 'jobsUpdate', jobs: all });
    if (active.length === 0) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
      return;
    }
  }, 600);
}

// Expose completed files to the browser's download manager. The browser
// handles the normal Save As prompt while the native host remains the owner
// of the download job and file path.
const fileServer = http.createServer((req, res) => {
  const match = req.url && req.url.match(/^\/jobs\/(\d+)\/file$/);
  if (req.method !== 'GET' || !match) {
    res.writeHead(404).end('Not found');
    return;
  }
  const job = jobs.get(Number(match[1]));
  if (!job || job.status !== 'done' || !job.filepath || !fs.existsSync(job.filepath)) {
    res.writeHead(404).end('Completed file not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(job.filepath))}`,
  });
  fs.createReadStream(job.filepath).pipe(res);
});
fileServer.on('error', (err) => console.error('[youDl:native] File server error:', err.message));
fileServer.listen(8766, '127.0.0.1');

/* ── message dispatcher ───────────────────────────────────────────────── */

async function handleMessage(msg) {
  const id = msg.id;
  const path = msg.path || '';
  const method = (msg.method || 'GET').toUpperCase();
  const body = msg.body || {};

  try {
    // Health / Ping
    if (path === '/ping' || msg.action === 'ping') {
      const { version, ffmpeg } = await yt.ping();
      sendMsg({
        id,
        ok: true,
        data: { ok: true, version, ffmpeg, native: true, timestamp: Date.now() },
      });
      return;
    }

    // Video Resolve
    if (path === '/resolve' || msg.action === 'resolve') {
      const url = body.url || msg.url;
      if (!url || !/^https?:\/\//i.test(url)) {
        sendMsg({ id, ok: false, error: 'A valid http(s) URL is required.' });
        return;
      }
      const data = await yt.resolve(url);
      sendMsg({ id, ok: true, data });
      return;
    }

    // List Jobs
    if ((path === '/jobs' && method === 'GET') || msg.action === 'listJobs') {
      sendMsg({ id, ok: true, data: jobs.list() });
      return;
    }

    // Create Job
    if ((path === '/jobs' && method === 'POST') || msg.action === 'createJob') {
      const jobParams = body.url ? body : msg;
      const job = jobs.create(jobParams);
      sendMsg({ id, ok: true, data: job });
      ensureJobBroadcasting();
      return;
    }

    // Cancel Job
    const cancelMatch = path.match(/^\/jobs\/(\d+)\/cancel$/);
    if (cancelMatch || msg.action === 'cancelJob') {
      const jobId = Number(cancelMatch ? cancelMatch[1] : (msg.jobId || body.jobId));
      const res = jobs.cancel(jobId);
      sendMsg({ id, ok: true, data: res });
      return;
    }

    // Get Single Job
    const getMatch = path.match(/^\/jobs\/(\d+)$/);
    if (getMatch || msg.action === 'getJob') {
      const jobId = Number(getMatch ? getMatch[1] : (msg.jobId || body.jobId));
      const res = jobs.get(jobId);
      if (!res) {
        sendMsg({ id, ok: false, error: 'Unknown job.' });
      } else {
        sendMsg({ id, ok: true, data: res });
      }
      return;
    }

    if (msg.action === 'removeCompletedFile') {
      const removed = jobs.removeCompletedFile(Number(msg.jobId || body.jobId));
      sendMsg({ id, ok: true, data: { removed } });
      return;
    }

    sendMsg({ id, ok: false, error: `Unknown endpoint or action: ${path || msg.action}` });
  } catch (err) {
    console.error('[youDl:native] Handler error:', err);
    sendMsg({ id, ok: false, error: String(err.message || err) });
  }
}

console.error('[youDl:native] youDl Native Messaging Host ready');
