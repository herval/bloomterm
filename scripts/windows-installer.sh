#!/bin/bash
# Has GitHub build the Windows installer of this commit for a release, smoke test included, and
# fetches it. The app in it updates from the latest.json at <url>. GitHub never sees the updater's
# private key: scripts/release.sh signs the installer on this Mac.
#
#   scripts/windows-installer.sh <url> <file to write>
set -euo pipefail

cd "$(dirname "$0")/.."

WORKFLOW=windows-app.yml
URL=$1
OUT=$2

die() { printf 'windows-installer: %s\n' "$*" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || die "the working tree has changes; GitHub builds what's pushed (or use --no-windows)"
git fetch -q origin
branch=$(git rev-parse --abbrev-ref HEAD)
sha=$(git rev-parse HEAD)
[ "$sha" = "$(git rev-parse -q --verify "origin/$branch" || true)" ] || die "$branch isn't pushed as it is here; GitHub builds what's pushed (or use --no-windows)"

last_run() { gh run list --workflow "$WORKFLOW" --event workflow_dispatch --commit "$sha" --limit 1 --json databaseId -q '.[0].databaseId // 0'; }

before=$(last_run)
gh workflow run "$WORKFLOW" --ref "$branch" -f latest_url="$URL"
run=$before
for _ in {1..40}; do
  [ "$run" -gt "$before" ] && break
  sleep 3
  run=$(last_run || echo "$before")
done
[ "$run" -gt "$before" ] || die "GitHub didn't start the build"

echo "windows-installer: building $sha: $(gh run view "$run" --json url -q .url)"
# By asking again and again, not `gh run watch`: one network error shouldn't end a release.
SECONDS=0
while :; do
  status=$(gh run view "$run" --json status,conclusion -q '.status + " " + .conclusion' 2>/dev/null || true)
  case $status in
    "completed success") break ;;
    completed*) die "the build failed: gh run view $run --log-failed" ;;
  esac
  [ $SECONDS -lt 3600 ] || die "the build is still not done after an hour: gh run view $run"
  sleep 30
done

fetched=$(mktemp -d)
trap 'rm -rf "$fetched"' EXIT
gh run download "$run" -n bloomterm-windows-installer -D "$fetched"
installers=("$fetched"/*-setup.exe)
[ ${#installers[@]} = 1 ] && [ -s "${installers[0]}" ] || die "run $run has no single installer"
mv "${installers[0]}" "$OUT"
echo "windows-installer: $OUT"
