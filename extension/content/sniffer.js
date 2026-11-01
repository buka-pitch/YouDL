/**
 * youDl content script — "sniffer".
 *
 * Runs on YouTube pages and tells the background script what video is open
 * so the popup can offer it immediately (no manual paste needed).
 * YouTube is a SPA, so we listen for its own navigation event too.
 */
(function () {
'use strict';

let dead = false;   // becomes true if the extension is reloaded while this page stays open
const api = typeof browser !== 'undefined' ? browser : chrome;

function currentVideoUrl() {
  const loc = location.href;
  let m;
  if ((m = loc.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?[^#]*\b(?:v|video_id)=([A-Za-z0-9_-]{6,})/i))) {
    return `https://www.youtube.com/watch?v=${m[1]}`;
  }
  if ((m = loc.match(/^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i))) {
    return `https://www.youtube.com/shorts/${m[1]}`;
  }
  if ((m = loc.match(/^https?:\/\/(?:music\.)?youtube\.com\/watch\?[^#]*\bv=([A-Za-z0-9_-]{6,})/i))) {
    return loc.split('#')[0];
  }
  return null;
}

function report() {
  const url = currentVideoUrl();
  if (dead) return;
  try {
    api.runtime.sendMessage({ type: 'YDL_PAGE_VIDEO', videoUrl: url }, () => {
      if (/context invalidated/i.test(String(api.runtime.lastError || ''))) {
        dead = true;
        console.info('[youDl] extension context lost (extension reloaded?) — sniffer stopped. Refresh this tab.');
        return;
      }
      void api.runtime.lastError; // swallow "receiver closed" noise
    });
  } catch (e) {
    if (/context invalidated/i.test(String(e))) { dead = true; console.info('[youDl] extension context lost — sniffer stopped. Refresh this tab.'); }
  }
}

// Fire now and on YouTube's SPA navigation.
report();
window.addEventListener('yt-navigate-finish', () => setTimeout(report, 100));
window.addEventListener('popstate', () => setTimeout(report, 100));
})();
