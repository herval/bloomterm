#!/bin/sh
# Puts the Node that ships inside the desktop app in apps/desktop/src-tauri/binaries: the official
# build of a pinned version, checked against its pinned sha256 (from
# https://nodejs.org/dist/v$VERSION/SHASUMS256.txt). Git Bash runs this on Windows.
set -eu

VERSION=22.22.3

cd "$(dirname "$0")/.."
OUT=apps/desktop/src-tauri/binaries
STAMP=$OUT/.node-sha256

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    NAME=node-v$VERSION-darwin-arm64
    ARCHIVE=$NAME.tar.gz
    SHA256=0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207
    BIN=$OUT/node-aarch64-apple-darwin
    ;;
  MINGW*-x86_64 | MSYS*-x86_64)
    NAME=node-v$VERSION-win-x64
    ARCHIVE=$NAME.zip
    SHA256=6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33
    BIN=$OUT/node-x86_64-pc-windows-msvc.exe
    ;;
  *)
    echo "fetch-node: the desktop app is built for Apple silicon Macs and 64-bit Windows only, for now" >&2
    exit 1
    ;;
esac
if [ -x "$BIN" ] && [ -s "$BIN" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$SHA256" ]; then
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "fetch-node: downloading Node $VERSION"
curl -fsSL --retry 2 -o "$TMP/$ARCHIVE" "https://nodejs.org/dist/v$VERSION/$ARCHIVE"
if command -v shasum >/dev/null; then SUM='shasum -a 256'; else SUM=sha256sum; fi
echo "$SHA256  $TMP/$ARCHIVE" | $SUM -c - >/dev/null || {
  echo "fetch-node: $ARCHIVE doesn't match its pinned sha256" >&2
  exit 1
}
mkdir -p "$OUT"
case $ARCHIVE in
  *.zip)
    unzip -q "$TMP/$ARCHIVE" "$NAME/node.exe" -d "$TMP"
    mv "$TMP/$NAME/node.exe" "$BIN"
    ;;
  *)
    tar -xzf "$TMP/$ARCHIVE" -C "$TMP" "$NAME/bin/node"
    mv "$TMP/$NAME/bin/node" "$BIN"
    chmod 755 "$BIN"
    ;;
esac
echo "$SHA256" > "$STAMP"
echo "fetch-node: $BIN ($("$BIN" --version))"
