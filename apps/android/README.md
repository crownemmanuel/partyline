# PartyLine for Android

The crew phone app. It is built from `docs/ANDROID.md` and speaks `docs/PROTOCOL.md` v1.

## Build

You need JDK 17 or newer and the Android SDK (platform 36, build-tools 36). Set `ANDROID_HOME`
or write `sdk.dir=…` into `local.properties`.

```bash
./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # routing engine, protocol codec, shared samples
```

### Release APK (served by the host at `/download/partyline.apk`)

```bash
./gradlew assembleRelease        # app/build/outputs/apk/release/app-release.apk (~43 MB)
```

- **Signing**: a dedicated release key, kept outside the repo at
  `~/.partyline/keystore/partyline-release.jks` (alias `partyline`). Its path and passwords come
  from `~/.gradle/gradle.properties` (`PARTYLINE_RELEASE_STORE_FILE`,
  `PARTYLINE_RELEASE_STORE_PASSWORD`, `PARTYLINE_RELEASE_KEY_ALIAS`, `PARTYLINE_RELEASE_KEY_PASSWORD`)
  or the same names as environment variables. **Back up the keystore and its password.** Phones
  only accept an update signed with the same key; if it is lost, every phone must uninstall
  first. Without the key, `assembleRelease` produces an unsigned APK.
- **Size**: R8 + resource shrinking, arm64-v8a + armeabi-v7a only (x86_64 is emulator-only and
  stays in debug), and compressed native libraries. It is one universal APK, not ABI splits.
- **versionCode**: minutes since 2026-01-01 UTC, so every build installs over an older one
  (override with `-Ppartyline.versionCode=N`). versionName is set in `app/build.gradle.kts`.
- A debug build and a release build are signed with different keys, so switching between them
  needs an uninstall.

Voice isolation uses `app/src/main/jniLibs/*/libdfjni.so`, which is checked in, so Rust is not
needed for a normal build. To rebuild it after changing `native/dfjni`, you need rustup and NDK r27:

```bash
native/build-native.sh           # DeepFilterNet3 (model embedded) for arm64-v8a, armeabi-v7a, x86_64
./gradlew connectedDebugAndroidTest   # on a device: white noise must drop by more than 20 dB
```

The unit tests also decode every file in `../../packages/protocol/samples` when the monorepo is
checked out. Without it, those tests are skipped and the inline PROTOCOL.md samples still run.

Toolchain: AGP 8.13, Kotlin 2.2, compileSdk/targetSdk 36, minSdk 26, LiveKit Android 2.30,
core-telecom 1.0.1. Moving to SDK 37 needs AGP 9.1+, which is required by androidx.core 1.19+.

## Layout (`app/src/main/java/com/partyline/`)

| Path | What |
|---|---|
| `model/Protocol.kt`, `ProtocolCodec.kt` | §3.4 objects, REST bodies, envelope encode/decode |
| `model/RoutingEngine.kt` | §5.1, pure; unit-tested against the ARCHITECTURE §4.1 table |
| `net/Pinning.kt` | sha256 leaf pin / TOFU capture trust manager; one pinned OkHttp per server |
| `net/ServerClient.kt` | `/api/info`, `/api/join`, `/api/session`, `/api/messages` |
| `net/ControlSocket.kt` | `/api/ws`: auth, 15 s ping, 30 s pong watchdog, backoff 1-2-4-8-15 s (`net/Backoff.kt`) |
| `audio/RtcRetry.kt` | the same backoff for LiveKit connects; "Audio server unreachable, retrying" after 3 failures |
| `discovery/NsdDiscovery.kt` | `_partyline._tcp` browse + resolve + TXT, multicast lock |
| `audio/VoiceIsolation.kt`, `DeepFilter.kt` | DeepFilterNet3 as LiveKit's capture post-processor (JNI to `native/dfjni`) |
| `audio/RoomController.kt` | LiveKit room, the `mic` track (always published, muted when off-air), routing applied |
| `call/IntercomService.kt` | foreground service (microphone\|phoneCall), CallStyle notification, Wi-Fi/wake locks |
| `call/IntercomSession.kt` | the live state machine: welcome → room → routing → status, reconnect, rediscovery |
| `call/TelecomController.kt` | Core-Telecom self-managed call: hold on a real call, system mute, endpoint routing |
| `input/MediaButtons.kt` | headset hook = PTT down/up; play/pause click = toggle |
| `notify/` | channels, message/signal notifications, tones + vibration, optional TTS |
| `ui/MessagesUi.kt` | floating messages panel and the top pop-up card for new messages |
| `SessionViewModel.kt`, `ui/` | discovery → TOFU → join (code pad / QR) → crew screen, messages sheet, settings |

## Behaviour notes

- **TLS**: `GET /api/info` runs in capture mode, so the app can show the fingerprint and compare
  it with mDNS `fp`. Once trusted, the pin is stored per `serverId`, and REST, WS and LiveKit
  signaling (via `LiveKitOverrides.okHttpClient`) refuse any other certificate. A QR whose `fp`
  matches the presented cert is trusted without a prompt. The host's "Get the app" QR
  (`#install&code=…&fp=…&id=…`) is accepted the same way as `#join?code=…`.
- **Certificate change** (renewal about every 26 months, or a SAN/IP change; PROTOCOL proposed
  change 4): a pin mismatch on REST or WS ends the session with `CERT_CHANGED`, and the app
  re-runs the trust check for the saved server, using mDNS `fp` when it is seen within 3 s. The
  "Certificate changed" prompt shows the new fingerprint. Trust re-pins it and rejoins with the
  saved token, no code. A QR whose `fp` matches also re-pins without a prompt.
- **LiveKit URL**: the SDK appends `/rtc` itself, so it gets `wss://host:8443`.
- **LiveKit 2.30 quirk**: `ParticipantTrackPermission` NPEs in `toProto()` when
  `participantSid` is null. We pass `""`, which means "match by identity" (see `RoomController.apply`).
- **Telecom**: when the call is accepted, LiveKit runs with `NoAudioHandler` and Telecom owns
  focus and routing. The preference is Bluetooth > wired > speaker, never the earpiece. If
  Telecom refuses, the foreground service alone keeps the session up and LiveKit's AudioSwitch routes.
- **Live call notification** (the Android take on an iOS Live Activity): an ongoing CallStyle
  notification, public on the lock screen and promoted to an Android 16 Live Update (status-bar
  call chip, `POST_PROMOTED_NOTIFICATIONS`).
  - Big line: mic state and who is talking ("🎙 Live" / "🔇 Muted" / "🔒 Muted by producer" ·
    "🔊 names" or "Quiet").
  - Text line: the latest message ("💬 sender → text"), or "group · server".
  - Avatar: the group's initial in the group colour.
  - Actions: Hang up, Talk / Stop talking (a toggle like the headset button, hidden while the
    producer mutes me), and an inline Reply (RemoteInput, addressed by the same rules as the
    pop-up's Reply). Tapping the body opens the app.
  - Updates at most about once a second. CallStyle stays because Telecom expects it for the
    self-managed call.
- **Locked screen**: the foreground service (microphone|phoneCall), Core-Telecom call, partial
  wake lock and Wi-Fi lock keep WS and LiveKit up. This was checked on the emulator for 2 min
  locked plus 1 min of forced Doze. Vendor battery managers can still stop it, so the crew screen
  shows "Battery optimisation is on … Tap to allow" until the app is exempt.
- **Messages**: the full-width "💬 Messages" button (with the unread badge) opens a floating
  panel over the crew screen: history, quick replies, To: picker, 🔔 Call producer, text + Send.
  A live message from someone else while the panel is closed shows as a card at the top, over
  everything, with ↩ Reply and Close (Next / "+N more" / Close all when more are queued). It
  stays until dismissed, and Back closes it. History from the first `welcome` does not pop up.
  Reply opens the panel addressed by the message.send rules: an admin on either side gets
  `d:<sender>`; else `g:x` for a group message; else `all` if crewCanBroadcast; else the
  producer. `message.ack` is sent only when seen: pop-up closed or answered, panel opened
  (everything is acked, and new arrivals are acked at once while it is open), or the
  notification's Reply / Close / swipe-away. The background notification has an inline Reply
  (RemoteInput) and Close.
- **Process death**: `sessionActive` is persisted while live. If it is still set on the next
  launch, the battery-optimisation / vendor help dialog is shown.
- **Voice isolation**: a single "Voice isolation ON / OFF" button under Mic/Speaker. It is ON by
  default, remembered per device, and local only. The engine is DeepFilterNet3 (libDF via
  `native/dfjni`, model compiled into the `.so`, offline) at 48 kHz with a 100 dB attenuation
  limit, as LiveKit's capture post-processor. While it runs, WebRTC's software noise suppression
  is off; echo cancellation and AGC stay on. Turning it OFF bypasses the model at once and swaps
  the mic track for one with WebRTC suppression. If the library or the 48 kHz full-band frame is
  missing, it falls back to WebRTC plus the platform suppressor (VOICE_COMMUNICATION source), and
  the button says "(basic)".
- **Crew screen**: the same layout as the iOS app and the web client, on black, top to bottom:
  - a header with the group name in the group colour, the server name and the device name;
  - "Quiet" or "Talking: …";
  - the "Hold to talk | Tap on / off" switch, which sets `live.talkMode` and is locked with
    "Talk mode set by the producer" while `forcedTalkMode` is set;
  - the talk button: blue #3a7bd5, red while live, grey with a lock for "MUTED BY PRODUCER";
  - the Muted / "Live · tap to mute" tile and the Speaker on / off tile;
  - the voice-isolation bar;
  - the 💬 Messages pill.
- **App icon**: generated from the shared `packages/protocol/assets/app-icon-1024.png`. The adaptive icon has a #000000
  background, the artwork at 70% of the 108 dp foreground (inside the 66 dp safe zone), and a
  monochrome layer for themed icons. It comes with legacy `ic_launcher` / `ic_launcher_round`
  for mdpi to xxxhdpi and a 512 px `app/src/main/ic_launcher-playstore.png`.
