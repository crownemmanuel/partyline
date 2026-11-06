Files bundled into the desktop app's resources.

- `partyline.apk`: the Android app, served to phones at `/download/partyline.apk` and offered on
  the `/#install` page. Put it here with `scripts/fetch-apk.sh` before `tauri build`. If it's
  missing, the host simply doesn't offer an Android download.
