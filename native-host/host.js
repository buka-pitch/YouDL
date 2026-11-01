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

    if (active.length === 0) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
      return;
    }

    // Broadcast current snapshots to the extension
    sendMsg({ event: 'jobsUpdate', jobs: all });
  }, 600);
}

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

    sendMsg({ id, ok: false, error: `Unknown endpoint or action: ${path || msg.action}` });
  } catch (err) {
    console.error('[youDl:native] Handler error:', err);
    sendMsg({ id, ok: false, error: String(err.message || err) });
  }
}

console.error('[youDl:native] youDl Native Messaging Host ready');
