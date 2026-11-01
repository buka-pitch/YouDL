#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.youdl.helper"
RUN_SH="$DIR/run.sh"
DEFAULT_EXT_ID="cfbkoncfgcphkmgapphbnmeooacnkfkc"
EXTRA_EXT_ID="$1"

chmod +x "$RUN_SH" "$DIR/host.js"

echo "================================================"
echo "    youDl Native Messaging Host Installer"
echo "================================================"

# Verify Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not found on your PATH."
  echo "   Please install Node.js from https://nodejs.org and re-run this script."
  exit 1
fi
echo "✓ Node.js detected: $(node -v)"

# Check yt-dlp
if command -v yt-dlp >/dev/null 2>&1; then
  echo "✓ yt-dlp detected: $(yt-dlp --version)"
else
  echo "⚠️ yt-dlp was not found on your PATH."
  echo "   Downloads will require yt-dlp. Install via: pip install yt-dlp"
fi

# Check ffmpeg. It is only required for downloads that need merging or conversion.
if command -v ffmpeg >/dev/null 2>&1; then
  echo "✓ ffmpeg detected: $(ffmpeg -version 2>/dev/null | head -n 1)"
else
  echo "⚠️ ffmpeg was not found on your PATH."
  echo "   Downloads needing separate audio/video streams or conversion may fail."
  echo "   Install ffmpeg and restart your browser, or choose a single-file format."
fi

# Determine allowed origins
ORIGINS="\"chrome-extension://$DEFAULT_EXT_ID/\""
if [ -n "$EXTRA_EXT_ID" ] && [ "$EXTRA_EXT_ID" != "$DEFAULT_EXT_ID" ]; then
  ORIGINS="$ORIGINS, \"chrome-extension://$EXTRA_EXT_ID/\""
fi

# Detect OS & setup target directories
OS="$(uname -s)"
CHROMIUM_TARGETS=()
FIREFOX_TARGETS=()

if [ "$OS" = "Darwin" ]; then
  # macOS
  CHROMIUM_TARGETS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  )
  FIREFOX_TARGETS=(
    "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  )
else
  # Linux
  CHROMIUM_TARGETS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
  )
  FIREFOX_TARGETS=(
    "$HOME/.mozilla/native-messaging-hosts"
  )
fi

# Create Chromium manifest content
CHROMIUM_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "youDl local download helper",
  "path": "$RUN_SH",
  "type": "stdio",
  "allowed_origins": [
    $ORIGINS
  ]
}
EOF
)

# Create Firefox manifest content
FIREFOX_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "youDl local download helper",
  "path": "$RUN_SH",
  "type": "stdio",
  "allowed_extensions": [
    "youdl@local"
  ]
}
EOF
)

INSTALLED_COUNT=0

# Install for Chromium browsers (Chrome, Brave, Edge, Chromium)
for TARGET_DIR in "${CHROMIUM_TARGETS[@]}"; do
  PARENT_DIR="$(dirname "$TARGET_DIR")"
  # If parent browser directory exists or if standard Chrome/Brave/Edge path, create and install
  mkdir -p "$TARGET_DIR"
  echo "$CHROMIUM_JSON" > "$TARGET_DIR/$HOST_NAME.json"
  echo "  ✓ Registered in: $TARGET_DIR"
  INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
done

# Install for Firefox
for TARGET_DIR in "${FIREFOX_TARGETS[@]}"; do
  mkdir -p "$TARGET_DIR"
  echo "$FIREFOX_JSON" > "$TARGET_DIR/$HOST_NAME.json"
  echo "  ✓ Registered in: $TARGET_DIR"
  INSTALLED_COUNT=$((INSTALLED_COUNT + 1))
done

echo ""
echo "================================================"
echo "🎉 youDl Native Messaging Host is ready!"
echo "   Registered in $INSTALLED_COUNT browser directories."
echo ""
echo "   Next steps:"
echo "   1. Open Chrome, Brave, Edge, or Firefox."
echo "   2. In your browser extensions, reload youDl."
echo "   3. youDl will automatically connect natively —"
echo "      NO manual server or terminal commands needed!"
echo "================================================"
