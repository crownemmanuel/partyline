# Builds, releases and app updates

The desktop app (`apps/desktop`) is built by GitHub Actions for **macOS (Apple silicon)**,
**Windows x64** and **Linux x64**, and installed copies update themselves from the GitHub releases
of [crownemmanuel/partyline](https://github.com/crownemmanuel/partyline/releases), but only when
the operator presses **Update**.

```
this computer                          GitHub Actions                        installed app
node scripts/release.ts 0.2.0    →    Release workflow                      "PartyLine 0.2.0 is available"
git push origin HEAD v0.2.0           builds macOS + Windows + Linux,       → Update → restart into 0.2.0
                                      signs the update files,
                                      publishes the release + latest.json
```

## Automatic builds

- **Every push to `main`** runs [Build](../.github/workflows/build.yml): typecheck, web client and
  Rust tests, then installers for all three platforms, kept as workflow artifacts for 14 days
  (Actions → Build → the run → Artifacts). They have no update files; use them to try a change
  on another OS. Pull requests run the checks only. Changes only under `website/`, `docs/`,
  `apps/ios/` or `apps/android/` skip it.
- **A `v*` tag** runs [Release](../.github/workflows/release.yml), below.

## In the installed app

- About 20 seconds after start, and every six hours after, the app asks GitHub whether a newer
  version is published. That is all it does by itself: it never downloads, installs or restarts
  on its own.
- When there is one, a green **PartyLine 0.2.0 is available · Update** notice shows on the Home
  screen, under the host status bar, and in Settings (which also has **Check for updates** and the
  release notes). On macOS, **PartyLine → Check for Updates…** in the menu bar checks right away
  and answers in a dialog (up to date, or **Update and Restart** / **Later**).
- **Update** downloads the update, checks its signature, stops hosting (or the join proxy),
  installs and restarts. The app comes back in the same role with the same join code, groups and
  certificate, so phones reconnect by themselves after a few seconds. Do it between shows, not
  during one. On Windows the installer shows its progress for a moment.
- The host data (`app.partyline.desktop` data folder: database, certificate, prefs) is not touched
  by an update. Never change `identifier` in `tauri.conf.json`: the app would start empty and every
  phone would see a new certificate.
- Linux: the **AppImage** updates itself; a **.deb** install does not (install the newer .deb).
- Development builds (`npm run dev`, `tauri build --debug`) can check but never install.

The check and install run in Rust (`apps/desktop/src-tauri/src/updater.rs`, commands
`update_status`, `update_check`, `update_install`); no webview gets the updater plugin's own
commands. The UI is `packages/web-client/src/components/UpdateNotice.tsx`.

## Cutting a release

The version lives in one place, `apps/desktop/package.json`. `tauri.conf.json` reads it from there
(`"version": "../package.json"`), and the release script keeps `Cargo.toml` and `Cargo.lock` equal
to it. The release workflow refuses a tag that does not match.

1. Commit the work that goes into the release (on `main`).
2. Set the version, commit it and tag it:

   ```bash
   node scripts/release.ts 0.2.0
   ```

   `patch`, `minor` or `major` count up from the current version instead. The release notes shown
   in the app are the tag message: by default the commit subjects since the last release, or your
   own with `--notes "Fixes the headset button"`. `--dry-run` shows what would happen. Only the
   version files are committed; nothing is pushed.
3. Push the commit and the tag. This starts the build:

   ```bash
   git push origin HEAD v0.2.0
   ```

4. Watch **Actions → Release** (about 20–40 minutes). The release stays a hidden draft until all
   three builds succeeded and `latest.json` lists macOS, Windows and Linux; then it is published
   and installed apps see it at their next check (or straight away with **Check for updates**).

A version with a suffix (`0.2.0-beta.1`) is published as a **pre-release**: apps never offer it,
so it is the way to try an installer by hand first.

If a build fails, the release stays a draft and no app sees it. Re-run the failed job, or cut a new
patch version. **Actions → Release → Run workflow** rebuilds an existing tag whose release is still
a draft. A published release is never rebuilt.

What a release contains:

| File | For |
| --- | --- |
| `PartyLine_<v>_aarch64.dmg` | macOS installer |
| `PartyLine_aarch64.app.tar.gz` (+ `.sig`) | what the Mac app updates from |
| `PartyLine_<v>_x64-setup.exe` (+ `.sig`) | Windows installer, and what the Windows app updates from |
| `PartyLine_<v>_amd64.AppImage` (+ `.sig`) | Linux, self-updating |
| `PartyLine_<v>_amd64.deb` | Linux (Debian/Ubuntu) |
| `latest.json` | what installed apps read: version, notes, download links, signatures |

## One-time GitHub setup

1. The repository is **public**: installed apps download `latest.json` and the updates without
   signing in, which a private repository's releases do not allow.
2. Two repository secrets (Settings → Secrets and variables → Actions) hold the update signing key:
   - `TAURI_SIGNING_PRIVATE_KEY`: `~/.tauri/partyline.key` on the build Mac
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: `~/.tauri/partyline.key.password`

   To set them again: `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/partyline.key` and
   `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD < ~/.tauri/partyline.key.password`.
3. Copies installed before the first release with an updater have none: install that release by
   hand. From then on, updates come through the app.

## The signing key

Every update is signed, and the app installs only files signed with the key whose public half is
built into it (`plugins.updater.pubkey` in `apps/desktop/src-tauri/tauri.conf.json`).

- The private key and its password are in `~/.tauri/` (owner-only files) and in the two GitHub
  secrets. **Never commit them** (`.gitignore` excludes `*.key`). Keep a copy in a password
  manager: if the key is lost, installed apps can no longer take updates and must be reinstalled
  by hand from a release made with a new key.
- To change keys: `npx tauri signer generate -w ~/.tauri/new.key`, put the new public key in
  `tauri.conf.json`, release that version while the secrets still hold the old key, then switch
  the secrets for the releases after it.

## Building on this computer

- `npm --prefix apps/desktop run build:installer`: installers for this computer, no update files,
  no key needed (`apps/desktop/src-tauri/target/release/bundle/`).
- `npx tauri build` also makes the update files, so it needs the key:

  ```bash
  cd apps/desktop
  TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/partyline.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/partyline.key.password)" npx tauri build
  ```

## Not code-signed yet

The update signature above is separate and always there, but the installers are not signed with
an Apple Developer ID or a Windows certificate:

- **macOS**: after dragging to Applications, run once: `xattr -cr /Applications/PartyLine.app`.
- **Windows**: SmartScreen may say "Windows protected your PC": **More info → Run anyway**.

Adding Apple notarization or Windows signing later only means more secrets for the workflow
([Tauri distribution guides](https://v2.tauri.app/distribute/)).

## Not in the desktop build yet

- The bundled Android APK (`resources/partyline.apk`, served to phones at `/download/partyline.apk`)
  is too large for git and is not built in CI, so release builds don't offer an Android download.
  Build it locally with `scripts/fetch-apk.sh`.
- macOS Intel: LiveKit publishes no macOS binary, and the sidecar comes from the Homebrew bottle
  of the runner's architecture (Apple silicon).
