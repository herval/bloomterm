#!/bin/sh
# Puts the Node that ships inside the desktop app at
# apps/desktop/src-tauri/binaries/node-aarch64-apple-darwin: the official build of a pinned
# version, checked against its pinned sha256 (from https://nodejs.org/dist/v$VERSION/SHASUMS256.txt).
set -eu

VERSION=22.22.3
NAME=node-v$VERSION-darwin-arm64
SHA256=0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207

cd "$(dirname "$0")/.."
OUT=apps/desktop/src-tauri/binaries
BIN=$OUT/node-aarch64-apple-darwin
STAMP=$OUT/.node-sha256

if [ "$(uname -sm)" != "Darwin arm64" ]; then
  echo "fetch-node: the desktop app is built for Apple silicon Macs only, for now" >&2
  exit 1
fi
if [ -x "$BIN" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SHA256" ]; then
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "fetch-node: downloading Node $VERSION"
curl -fsSL --retry 2 -o "$TMP/$NAME.tar.gz" "https://nodejs.org/dist/v$VERSION/$NAME.tar.gz"
echo "$SHA256  $TMP/$NAME.tar.gz" | shasum -a 256 -c - >/dev/null || {
  echo "fetch-node: $NAME.tar.gz doesn't match its pinned sha256" >&2
  exit 1
}
tar -xzf "$TMP/$NAME.tar.gz" -C "$TMP" "$NAME/bin/node"
mkdir -p "$OUT"
mv "$TMP/$NAME/bin/node" "$BIN"
chmod 755 "$BIN"
echo "$SHA256" > "$STAMP"
echo "fetch-node: $BIN ($("$BIN" --version))"
