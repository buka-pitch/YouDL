# youDl personal-use bundle

youDl runs `yt-dlp` on your computer. The browser connects to the local Native Messaging Host, which the browser starts when needed. The host briefly opens a local-only file transfer port so the browser can save completed downloads to your chosen location.

## Requirements

- Node.js 18 or newer
- `yt-dlp` available on your PATH
- `ffmpeg` available on your PATH for merging separate audio/video streams and conversion. The installer checks for it and warns if it is missing; it does not install ffmpeg.

## Install

1. Register the native host once:
   - Linux / macOS: from the extracted `youDl` folder, run `./native-host/install.sh`.
   - Windows: double-click `native-host\\install.bat`.
2. Load the extension:
   - Chrome, Edge, or Brave: open the browser's extensions page, enable Developer mode, choose **Load unpacked**, and select the `extension` folder.
   - Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extension/manifest.firefox.json`. Temporary add-ons need to be loaded again after Firefox restarts.
3. Reload the extension after registering the host. The browser starts the host automatically when you use youDl.

If you use an unpacked Chromium extension with a different extension ID, pass that ID to `install.sh` or `install.bat` so the host allows it.

## Use it

On a YouTube watch or Shorts page, use the youDl control. You can also paste a video URL in the popup. Choose a quality and format, then download. Other site support depends on yt-dlp and each site's availability.

This is an unpacked personal-use tool and is not listed in the Chrome Web Store or Firefox Add-ons marketplace. Only save videos you have permission to download.
