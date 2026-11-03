# Releasing bloomterm

A release is the desktop app for other Macs: signed with a Developer ID, under the hardened
runtime, notarized by Apple, in a DMG, plus the files its updater reads. `scripts/release.sh` does
all of it; SPEC §8.7 has the design.

```sh
make release                       # build, sign, notarize and publish v<version in tauri.conf.json>
make release-build                 # the same without publishing, into dist/release/<version>/
scripts/release.sh --no-notarize   # build and check the signatures only
```

To cut one, bump `version` in `apps/desktop/src-tauri/tauri.conf.json`, commit, and `make release`.
Publishing needs a clean tree and a version that isn't released yet.

## What the releasing Mac needs

An Apple silicon Mac with Rust, `gh` signed in, and:

| What | Default | Override |
|---|---|---|
| A Developer ID Application certificate in the keychain | the maintainer's | `BLOOMTERM_SIGNING_IDENTITY` |
| A notarytool profile in the keychain | `bloomterm-notary` | `BLOOMTERM_NOTARY_PROFILE` |
| The updater's private key, with its password in the keychain (service `bloomterm-updater-key`) | `~/.tauri/bloomterm-updater.key` | `BLOOMTERM_UPDATER_KEY` |
| A repo you can publish releases to | `herval/bloomterm` | `BLOOMTERM_RELEASES_REPO` |

The notarytool profile, made once:

```sh
xcrun notarytool store-credentials bloomterm-notary --apple-id <your Apple ID> --team-id <your team ID>
```

Back up the updater's private key and its password. Without them, installed apps can't update.

## Releasing from a fork

Official builds update from `herval/bloomterm`'s releases, and only accept updates signed with its
key. To ship your own builds:

1. Make an updater key pair: `cd apps/desktop && node_modules/.bin/tauri signer generate -w ~/.tauri/bloomterm-updater.key`.
   Store its password in the keychain:
   `security add-generic-password -s bloomterm-updater-key -a "$USER" -w`.
2. Put the public key in `plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.release.conf.json`.
3. Change `identifier` in `apps/desktop/src-tauri/tauri.conf.json` to one of your own, so your
   app and the official one don't share settings.
4. Set the variables above to your certificate, notarytool profile and releases repo, and run
   `make release`.
