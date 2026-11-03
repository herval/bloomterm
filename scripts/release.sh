#!/bin/bash
# Builds bloomterm.app for other Macs and publishes it (SPEC §8.7): signed with a Developer ID,
# under the hardened runtime, notarized by Apple, in a DMG, with what the app's updater reads.
#
#   scripts/release.sh                build v<version in tauri.conf.json>, then publish it
#   scripts/release.sh --no-publish   everything but the upload, into dist/release/<version>/
#   scripts/release.sh --no-notarize  only build and sign, to check the build (no upload either)
#
# It needs, on this Mac:
#   - the Developer ID Application certificate in the keychain     $BLOOMTERM_SIGNING_IDENTITY
#   - a notarytool profile in the keychain, made once with          $BLOOMTERM_NOTARY_PROFILE
#       xcrun notarytool store-credentials bloomterm-notary --apple-id <id> --team-id N57JK357GW
#   - the updater's private key, ~/.tauri/bloomterm-updater.key, and its password in the keychain
#     (service bloomterm-updater-key). Its public key is in tauri.release.conf.json: lose the
#     private key and installed apps can't update anymore.
#   - gh, signed in, and allowed to publish releases on               $BLOOMTERM_RELEASES_REPO
#     (this repo, herval/bloomterm, unless you set it)
#
# A release v<version> on the releases repo holds:
#   bloomterm.dmg          what people download: …/releases/latest/download/bloomterm.dmg
#   bloomterm.app.tar.gz   what the app's updater downloads (its signature is in latest.json)
#   latest.json            what the app's updater checks: …/releases/latest/download/latest.json
set -euo pipefail

cd "$(dirname "$0")/.."

IDENTITY=${BLOOMTERM_SIGNING_IDENTITY:-"Developer ID Application: Herval Albuquerque (N57JK357GW)"}
PROFILE=${BLOOMTERM_NOTARY_PROFILE:-bloomterm-notary}
REPO=${BLOOMTERM_RELEASES_REPO:-herval/bloomterm}
KEY=${BLOOMTERM_UPDATER_KEY:-$HOME/.tauri/bloomterm-updater.key}

publish=1
notarize=1
for arg in "$@"; do
  case $arg in
    --no-publish) publish=0 ;;
    --no-notarize) notarize=0; publish=0 ;;
    *) echo "usage: scripts/release.sh [--no-publish | --no-notarize]" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1mrelease:\033[0m %s\n' "$*"; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }
# The native code (Mach-O files) under a folder, one path a line.
machos() { find "$1" -type f -print0 | xargs -0 file -N | awk -F': ' '/Mach-O/ { print $1 }'; }

VERSION=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
TAG=v$VERSION
OUT=dist/release/$VERSION
APP_BUILT=apps/desktop/src-tauri/target/release/bundle/macos/bloomterm.app
LATEST_URL=https://github.com/$REPO/releases/latest/download/latest.json
TARBALL_URL=https://github.com/$REPO/releases/download/$TAG/bloomterm.app.tar.gz

# --- Everything this needs, checked before the long build. ---

[ "$(uname -sm)" = "Darwin arm64" ] || die "releases are built on an Apple silicon Mac"
security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\"" || die "no signing identity \"$IDENTITY\" in the keychain"
[ -r "$KEY" ] || die "no updater key at $KEY"
KEY_PASSWORD=$(security find-generic-password -s bloomterm-updater-key -w 2>/dev/null) || die "no password for the updater key in the keychain (service bloomterm-updater-key)"
if [ $notarize = 1 ]; then
  xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 ||
    die "no notarytool profile \"$PROFILE\": xcrun notarytool store-credentials $PROFILE --apple-id <id> --team-id N57JK357GW"
fi
if [ $publish = 1 ]; then
  [ -z "$(git status --porcelain)" ] || die "the working tree has changes; commit them, or use --no-publish"
  gh repo view "$REPO" >/dev/null 2>&1 || die "can't see $REPO with gh"
  ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 || die "$TAG is already released; bump \"version\" in apps/desktop/src-tauri/tauri.conf.json"
fi

commit=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || commit="$commit, with uncommitted changes"
say "bloomterm $VERSION ($commit)"
rm -rf "$OUT"
mkdir -p "$OUT"

# --- Build and sign. ---

make build
node scripts/bundle.mjs
scripts/fetch-node.sh

# Tauri signs the app's own binaries (the shell and Node); the native code among its resources
# is signed here, under the hardened runtime too, or notarization turns the app down.
while IFS= read -r f; do
  say "signing ${f#dist/bundle/}"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$f"
done < <(machos dist/bundle)

say "building the app"
# Tauri would notarize on its own with these set; this script does it, after the checks below.
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
overrides=$(node -e 'console.log(JSON.stringify({ bundle: { macOS: { signingIdentity: process.argv[1] } }, plugins: { updater: { endpoints: [process.argv[2]] } } }))' "$IDENTITY" "$LATEST_URL")
(cd apps/desktop && node_modules/.bin/tauri build --ci --bundles app --features updater \
  --config src-tauri/tauri.release.conf.json --config "$overrides")

ditto "$APP_BUILT" "$OUT/bloomterm.app"
APP=$OUT/bloomterm.app

# --- Check the signatures before Apple does. ---

say "checking signatures"
codesign --verify --deep --strict "$APP"
team=$(echo "$IDENTITY" | sed -E 's/.*\(([A-Z0-9]+)\)$/\1/')
count=0
while IFS= read -r f; do
  info=$(codesign -dv --verbose=2 "$f" 2>&1)
  grep -q "TeamIdentifier=$team" <<<"$info" || die "${f#$APP/} isn't signed by team $team"
  grep -q 'flags=.*(runtime)' <<<"$info" || die "${f#$APP/} isn't under the hardened runtime"
  grep -q '^Timestamp=' <<<"$info" || die "${f#$APP/} has no secure timestamp"
  count=$((count + 1))
done < <(machos "$APP")
say "$count native files, all signed by $team under the hardened runtime"
codesign -d --entitlements - --xml "$APP/Contents/MacOS/node" 2>/dev/null | grep -q 'com.apple.security.cs.allow-jit' ||
  die "Node has no JIT entitlement, so bloomd can't run"

# Node runs under the hardened runtime, and loads the SQLite addon.
say "checking that Node and SQLite run signed"
"$APP/Contents/MacOS/node" -e '
  const Database = require(process.argv[1]);
  const row = new Database(":memory:").prepare("select 41 + 1 as answer").get();
  if (row.answer !== 42) process.exit(1);
' "$PWD/$APP/Contents/Resources/bundle/node_modules/better-sqlite3"
"$APP/Contents/MacOS/node" --disable-warning=ExperimentalWarning "$APP/Contents/Resources/bundle/bt.mjs" --help >/dev/null

if [ $notarize = 0 ]; then
  say "signed, not notarized: $APP"
  exit 0
fi

# --- Notarize: the app, then the DMG with the app inside. ---

# Submits a file and waits for Apple's verdict; prints Apple's log when it isn't Accepted.
notarize_file() {
  local result id status
  result=$(xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait --output-format json)
  id=$(node -p 'JSON.parse(process.argv[1]).id' "$result")
  status=$(node -p 'JSON.parse(process.argv[1]).status' "$result")
  if [ "$status" != Accepted ]; then
    xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true
    die "Apple didn't accept $1: $status (submission $id)"
  fi
  say "notarized $(basename "$1") (submission $id)"
}

say "notarizing the app (usually a few minutes)"
ditto -c -k --keepParent "$APP" "$OUT/bloomterm-notarize.zip"
notarize_file "$OUT/bloomterm-notarize.zip"
rm "$OUT/bloomterm-notarize.zip"
xcrun stapler staple -q "$APP"
spctl --assess --type execute "$APP" || die "Gatekeeper turns down the notarized app"

say "making the DMG"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ditto "$APP" "$stage/bloomterm.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname bloomterm -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$OUT/bloomterm.dmg"
codesign --force --timestamp --sign "$IDENTITY" "$OUT/bloomterm.dmg"
notarize_file "$OUT/bloomterm.dmg"
xcrun stapler staple -q "$OUT/bloomterm.dmg"
spctl --assess --type open --context context:primary-signature "$OUT/bloomterm.dmg" || die "Gatekeeper turns down the DMG"

# --- What the updater reads. ---

say "signing the update"
COPYFILE_DISABLE=1 tar -C "$OUT" -czf "$OUT/bloomterm.app.tar.gz" bloomterm.app
(cd apps/desktop && node_modules/.bin/tauri signer sign --app-version "$VERSION" -f "$KEY" -p "$KEY_PASSWORD" "../../$OUT/bloomterm.app.tar.gz" >/dev/null)
[ -s "$OUT/bloomterm.app.tar.gz.sig" ] || die "the updater's signature wasn't written"

previous=$(git describe --tags --abbrev=0 --match 'v*' HEAD^ 2>/dev/null || true)
{
  if [ -n "$previous" ]; then
    echo "Changes since $previous:"
    echo
    git log --no-merges --format='- %s' "$previous..HEAD"
  else
    echo "The first release of bloomterm for other Macs."
  fi
} >"$OUT/notes.md"

node -e '
  const [version, url, sigFile, notesFile, out] = process.argv.slice(1);
  const fs = require("node:fs");
  const latest = {
    version,
    notes: fs.readFileSync(notesFile, "utf8").trim(),
    pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": { signature: fs.readFileSync(sigFile, "utf8").trim(), url } },
  };
  fs.writeFileSync(out, JSON.stringify(latest, null, 2) + "\n");
' "$VERSION" "$TARBALL_URL" "$OUT/bloomterm.app.tar.gz.sig" "$OUT/notes.md" "$OUT/latest.json"

if [ $publish = 0 ]; then
  say "built $OUT: bloomterm.dmg, bloomterm.app.tar.gz, latest.json (not published)"
  exit 0
fi

# --- Publish: a draft with every file, then made public at once, so the updater never sees a
# latest.json whose files aren't there yet. ---

say "publishing $TAG to $REPO"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git tag -a "$TAG" -m "bloomterm $VERSION"
git push -q origin "$TAG"
gh release create "$TAG" --repo "$REPO" --draft --title "bloomterm $VERSION" --notes-file "$OUT/notes.md" \
  "$OUT/bloomterm.dmg" "$OUT/bloomterm.app.tar.gz" "$OUT/latest.json"
gh release edit "$TAG" --repo "$REPO" --draft=false >/dev/null
say "released: https://github.com/$REPO/releases/latest/download/bloomterm.dmg"
