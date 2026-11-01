/**
 * youDl server — local HTTP helper for the youDl browser extension.
 *
 * Binds to 127.0.0.1 only. Endpoints:
 *   GET  /ping            → { ok, version, ffmpeg }
 *   POST /resolve         → metadata + format inventory for a URL
 *   GET  /jobs            → job history
 *   POST /jobs            → start a download  { url, preset?, output? }
 *   GET  /jobs/:id        → job status
 *   POST /jobs/:id/cancel → cancel a job
 *
 * Security model: This is a YOU-only server. It trusts whoever can open a
 * TCP connection to localhost. Browsers treat 127.0.0.1 as potentially
 * trustworthy but a malicious website could try to reach it — so every
 * mutating endpoint also requires header `x-youdl-token` matching the value
 * the extension stores (generated per server start, printed in the log).
 */
'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const yt = require('./yt');
const jobs = require('./jobs');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.YOUDL_PORT || 8765);
const TOKEN = process.env.YOUDL_TOKEN || crypto.randomBytes(16).toString('hex');

// Token gate for mutation endpoints.
app.use('/jobs', (req, res, next) => {
  if (req.method !== 'GET' && req.headers['x-youdl-token'] !== TOKEN) {
    return res.status(403).json({ error: 'Missing or invalid x-youdl-token. Reload the youDl popup.' });
  }
  next();
});
app.use('/resolve', (req, res, next) => {
  if (req.headers['x-youdl-token'] !== TOKEN) {
    return res.status(403).json({ error: 'Missing or invalid x-youdl-token. Reload the youDl popup.' });
  }
  next();
});

/* ── health ─────────────────────────────────────────────────────────── */
app.get('/ping', async (_req, res) => {
  try {
    const { version, ffmpeg } = await yt.ping();
    res.json({ ok: true, version, ffmpeg, token: TOKEN });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

/* ── resolve ────────────────────────────────────────────────────────── */
app.post('/resolve', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'A valid http(s) URL is required.' });
  }
  try {
    res.json(await yt.resolve(url));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ── jobs ───────────────────────────────────────────────────────────── */
app.get('/jobs', (_req, res) => res.json(jobs.list()));

app.post('/jobs', (req, res) => {
  const { url, title, preset, format, output } = req.body || {};
  try {
    res.status(201).json(jobs.create({ url, title, preset, format, output }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/jobs/:id', (req, res) => {
  const job = jobs.get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  res.json(job);
});

app.get('/jobs/:id/file', (req, res) => {
  const job = jobs.get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  if (job.status !== 'done' || !job.filepath) {
    return res.status(400).json({ error: 'Job is not completed yet.' });
  }
  if (!fs.existsSync(job.filepath)) {
    return res.status(404).json({ error: 'File does not exist on disk.' });
  }
  const filename = path.basename(job.filepath);
  res.download(job.filepath, filename);
});

app.post('/jobs/:id/cancel', (req, res) => {
  const job = jobs.cancel(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  res.json(job);
});

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`youDl helper listening on http://127.0.0.1:${PORT}`);
  console.log(`Session token: ${TOKEN}`);
  console.log(`get it for the extension via GET /ping`);
});
