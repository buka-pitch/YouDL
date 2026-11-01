# youDl

A **local, no-cloud YouTube downloader**: a small browser extension (Chrome, Edge, Brave, Firefox) that drives **yt-dlp running on your own machine** through a tiny localhost helper API. No third-party services, no scraping sites — your browser talks to your own server, which talks to YouTube using the open-source `yt-dlp` extractor.

```
┌──────────────┐     fetch      ┌─────────────────┐    spawn     ┌────────┐
│  extension   │ ─────────────▶ │  youDl helper   │ ───────────▶ │ yt-dlp │
│  (MV3 popup) │◀─── progress ──│  Node + Express │              │        │
└──────────────┘                └─────────────────┘              └────────┘
   your browser                    127.0.0.1:8765                your disk
```

### IDM-style hover overlay

On any YouTube watch or Shorts page, hovering the video player shows a **⬇ youDl** pill in the top-right of the player. Click it to get an inline quality menu (Best / 1080p / 720p / 480p / 360p / Audio only); picking one starts the download and the pill becomes a live progress meter until the button reads **saved ✓**. The overlay talks to the helper through the extension's background worker (page CSP blocks direct localhost fetches).

## Install

### 1. Helper (server)

Prerequisites: **Node 18+**, **yt-dlp** on your PATH (`pip install yt-dlp`, or equivalent), and **ffmpeg** for merging separate video/audio streams (`sudo apt install ffmpeg`).

```bash
cd server
npm install
npm start
# → youDl helper listening on http://127.0.0.1:8765
# → session token printed in the log (the extension fetches it automatically)
```

The server binds to **127.0.0.1 only** and gates write endpoints behind a per-session token. Files land in `~/Downloads/youDl/` by default (`YOUDL_OUTPUT` env var or per-request `output` to change).

### 2. Extension

**Chrome / Edge / Brave** — `brave://extensions` (or `chrome://extensions`, `edge://extensions`) → Developer mode → **Load unpacked** → select the `extension/` folder.

**Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `extension/manifest.firefox.json`.

> This extension is not publishable to the Chrome Web Store or AMO — marketplace policy prohibits YouTube-content downloaders. It is a personal, developer-mode tool, like yt-dlp itself.

## Use it

- Open a YouTube **watch** or **shorts** page → the toolbar icon shows a badge; hit the popup and the open video is pre-filled.
- Or paste any URL into the popup and press **Fetch**.
- Pick quality (**Best / 1080p / 720p / 480p / 360p / Audio only**) → **Download**.
- Watch progress; the finished file path appears when done. Cancel anytime while downloading.

## API (helper)

| Method | Endpoint             | Purpose                                  |
|--------|----------------------|------------------------------------------|
| GET    | `/ping`              | health check + version info + session token |
| POST   | `/resolve`           | metadata + format list for a URL         |
| GET    | `/jobs`              | job history (memory-only, lost on restart) |
| POST   | `/jobs`              | start a download `{url, preset?, output?}` |
| GET    | `/jobs/:id`          | job status + progress                    |
| POST   | `/jobs/:id/cancel`   | cancel a queued/running job              |

All mutating endpoints require header `x-youdl-token: <token from /ping>`.

## Project layout

```
server/                Node + Express wrapper around yt-dlp
  src/index.js         HTTP API, token gate, 127.0.0.1 bind
  src/yt.js            yt-dlp spawn, progress parsing, preset mapping
  src/jobs.js          in-memory job store, queue, cancel
extension/
  manifest.json        Chrome/Edge/Brave (MV3 service worker)
  manifest.firefox.json Firefox variant (background scripts)
  background.js        badge + tab video state + localhost API proxy
  content/sniffer.js   detects /watch and /shorts URLs on YouTube tabs
  content/overlay.js   IDM-style hover "⬇ youDl" pill + inline quality panel
  popup/               paste UI, quality picker, progress bar
```

## Design note & limits

- Nothing is uploaded or stored remotely; the helper is a thin process manager.
- Job history is in-memory: restart the helper, your history is clean.
- Downloads follow YouTube's availability: private/DRM/age-restricted videos fail unless yt-dlp can access them legitimately on your machine (cookies via `YOUDL_*` extension point later).
- Use for content you're permitted to save. You are responsible for that call, exactly as when running yt-dlp directly.
