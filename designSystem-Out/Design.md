# Design System: youDl

## 1. Context & Specification Summary
- **Form Factor**: Browser extension popup & in-player video overlay on YouTube.
- **App Type**: Media downloader and utility tool.
- **Framework & UI Stack**: React + Tailwind CSS (migrating from Vanilla JS / CSS).
- **App Identity**: Modern, compact, sleek dark utility.
- **Visual Reference**: Hybrid aesthetic blending YouTube-native dark theme and translucent/glassmorphic player overlay pills with clear, functional desktop downloader utilities (IDM/JDownloader clarity).
- **Color Direction**: Dark slate theme (`#101418` background, `#171c22` panel/surface, `#262d36` borders) with electric blue (`#1f6feb`) and YouTube red (`#ff0000` / `#f85149`) accents.

## 2. Design Tokens & Palette
- **Background Root**: `#101418` (`bg-slate-950` / custom `--bg`)
- **Card / Surface**: `#171c22` (`bg-slate-900/90` with backdrop-blur)
- **Border / Outline**: `#262d36` (`border-slate-800`)
- **Primary Text**: `#e6edf3` (`text-slate-100`)
- **Secondary / Muted Text**: `#8b98a5` (`text-slate-400`)
- **Primary Action (Blue)**: `#1f6feb` (`hover:bg-blue-600`)
- **Accent Brand (YouTube Red)**: `#ff0000` / `#e50914` (indicators / video badges)
- **Status Green (Done / OK)**: `#3fb950`
- **Status Red (Error)**: `#f85149`

## 3. Component Guidelines
- **Controls & Selectors**:
  - Quality selector (Best, 1080p, 720p, 480p, 360p, Audio only).
  - Format selector (MP4 [default], WebM, MP3 audio).
  - Compact, dense, high-contrast layouts.
- **Player Overlay**:
  - Floating translucent pill (`backdrop-blur-md bg-[#171c22]/90 border border-[#262d36] text-[#e6edf3]`).
  - Smooth micro-interactions on hover and download state changes.
  - Clear real-time download progress bar and status.
- **Popup UI**:
  - Auto-detected video banner with thumbnail and duration.
  - Dual dropdowns for Quality and Container Format.
  - Immediate responsive feedback for helper status and ffmpeg detection.
