#!/usr/bin/env bash
# Build alongside the normal app. This script never installs over /Applications/Autopod.app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DERIVED="$ROOT/packages/desktop/build-preview"
xcodebuild -project packages/desktop/Autopod.xcodeproj -scheme Autopod \
  -configuration Debug -derivedDataPath "$DERIVED" \
  AUTOPOD_APP_NAME="Autopod Preview" AUTOPOD_BUNDLE_ID=com.autopod.desktop.preview \
  AUTOPOD_INFO_PLIST=Autopod/Preview-Info.plist \
  CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES build
APP="$DERIVED/Build/Products/Debug/Autopod Preview.app"
codesign --verify --deep --strict "$APP"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist"
echo "Preview build: $APP"
