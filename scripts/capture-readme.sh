#!/usr/bin/env bash
# Render offline native fixtures without screen recording or modifying the installed app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:?Usage: bash scripts/capture-readme.sh /absolute/output/directory}"
[[ "$OUTPUT" = /* ]] || { echo 'Output path must be absolute' >&2; exit 2; }
[[ "$(uname)" = Darwin ]] || { echo 'Requires macOS and Xcode' >&2; exit 2; }
SOURCE="$(mktemp -d "${TMPDIR:-/tmp}/autopod-readme.XXXXXX")"
trap 'rm -rf "$SOURCE"' EXIT
# Pin before the build so a concurrent commit cannot change the provenance receipt.
REVISION="$(git -C "$ROOT" rev-parse HEAD)"
git -C "$ROOT" archive "$REVISION" packages/desktop | tar -x -C "$SOURCE"
cp "$ROOT/assets/readme/capture-native.swift" \
  "$SOURCE/packages/desktop/Autopod/AutopodXcodeApp.swift"
DERIVED="$SOURCE/derived"
xcodebuild -project "$SOURCE/packages/desktop/Autopod.xcodeproj" -scheme Autopod \
  -configuration Debug -derivedDataPath "$DERIVED" \
  AUTOPOD_APP_NAME="Autopod Readme Capture" \
  AUTOPOD_BUNDLE_ID=com.autopod.desktop.readme.capture \
  AUTOPOD_INFO_PLIST=Autopod/Preview-Info.plist AUTOPOD_PREVIEW_FIXTURES=YES \
  CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES build > "$SOURCE/build.log" 2>&1 \
  || { tail -n 80 "$SOURCE/build.log" >&2; exit 1; }
mkdir -p "$OUTPUT"
APP="$DERIVED/Build/Products/Debug/Autopod Readme Capture.app"
AUTOPOD_README_OUTPUT="$OUTPUT" "$APP/Contents/MacOS/Autopod Readme Capture"
printf '%s\n' "$REVISION" > "$OUTPUT/source-revision.txt"
# The renderer can intentionally be uncommitted; identify the exact copied overlay too.
shasum -a 256 "$SOURCE/packages/desktop/Autopod/AutopodXcodeApp.swift" \
  | awk '{print $1}' > "$OUTPUT/capture-host.sha256"
