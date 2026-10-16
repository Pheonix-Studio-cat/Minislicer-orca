#!/bin/bash
# Builds "Minislicer Runner.app" (universal: Apple silicon + Intel) and packs it into a .dmg.
# Runs on macOS only (lipo, codesign, hdiutil).
#
#   mobile/runner/package_macos.sh <version> <output-dir> [<dir with runner-arm64 and runner-amd64>]
#
# Without the third argument the two binaries are built here with Go. CI passes binaries
# cross-compiled on Linux, because the macOS runner image has no Go on its PATH.
set -euo pipefail

VERSION="${1:?version}"
OUT="${2:?output dir}"
PREBUILT="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MOBILE="$(dirname "$HERE")"
WORK="$(mktemp -d)"
APP="$WORK/dmg/Minislicer Runner.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT"
for arch in arm64 amd64; do
  if [ -n "$PREBUILT" ]; then
    cp "$PREBUILT/runner-$arch" "$WORK/runner-$arch"
  else
    (cd "$MOBILE" && CGO_ENABLED=0 GOOS=darwin GOARCH="$arch" go build -trimpath \
      -ldflags "-s -w -X main.version=$VERSION" -o "$WORK/runner-$arch" ./runner)
  fi
done
lipo -create -output "$APP/Contents/MacOS/minislicer-runner" "$WORK/runner-arm64" "$WORK/runner-amd64"

# LSUIElement: no Dock icon; the runner is controlled from its pairing page in the browser.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Minislicer Runner</string>
  <key>CFBundleDisplayName</key><string>Minislicer Runner</string>
  <key>CFBundleIdentifier</key><string>io.github.minislicer.runner</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>minislicer-runner</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>Your phone or tablet connects to the runner over the local network to send prints.</string>
</dict>
</plist>
PLIST

# Ad-hoc signature: required to run on Apple silicon. It is not a Developer ID, so Gatekeeper
# still asks the user to confirm the first start (see mobile/README.md).
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

ln -s /Applications "$WORK/dmg/Applications"
cp "$MOBILE/runner/INSTALL-macOS.txt" "$WORK/dmg/Read me first.txt"
hdiutil create -volname "Minislicer Runner" -srcfolder "$WORK/dmg" -ov -format UDZO \
  "$OUT/Minislicer-Runner-$VERSION-macOS.dmg"
rm -rf "$WORK"
echo "built $OUT/Minislicer-Runner-$VERSION-macOS.dmg"
