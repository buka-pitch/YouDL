#!/usr/bin/env bash
HOST_NAME="com.youdl.helper"
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  )
else
  DIRS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
    "$HOME/.mozilla/native-messaging-hosts"
  )
fi

for D in "${DIRS[@]}"; do
  if [ -f "$D/$HOST_NAME.json" ]; then
    rm -f "$D/$HOST_NAME.json"
    echo "Removed $D/$HOST_NAME.json"
  fi
done

echo "youDl Native Messaging Host uninstalled."
