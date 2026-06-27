#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# install-desktop.sh — build the macOS app and drop it in /Applications
#
# Single-user, local-dev install. No notarization / Developer ID needed:
# your own Mac trusts a locally-built (ad-hoc-signed) app, and copying via
# `cp` doesn't set the quarantine xattr, so Gatekeeper stays quiet.
#
# Usage:
#   ./scripts/install-desktop.sh            # build Release → /Applications/Autopod.app
#
# Driven by `ap desktop`, but safe to run directly. Idempotent.
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; DIM='\033[2m'; NC='\033[0m'
else
  RED=''; GREEN=''; DIM=''; NC=''
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo -e "${RED}The Autopod desktop app is macOS-only.${NC}" >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo -e "${RED}xcodebuild not found.${NC} Install Xcode (or the Command Line Tools) first." >&2
  exit 1
fi

PROJECT="packages/desktop/Autopod.xcodeproj"
DERIVED="packages/desktop/build"
APP="$DERIVED/Build/Products/Release/Autopod.app"
DEST="/Applications/Autopod.app"

echo -e "${DIM}Building Autopod.app (Release)…${NC}"
# Ad-hoc signing (CODE_SIGN_IDENTITY="-") so this works without a configured
# Apple Developer team. Fine for a self-install; not for distribution.
xcodebuild \
  -project "$PROJECT" \
  -scheme Autopod \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  build \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO

if [[ ! -d "$APP" ]]; then
  echo -e "${RED}Build succeeded but $APP is missing.${NC}" >&2
  exit 1
fi

echo -e "${DIM}Installing to $DEST…${NC}"
rm -rf "$DEST"
cp -R "$APP" "$DEST"

echo -e "${GREEN}Installed Autopod.app → $DEST${NC}"
