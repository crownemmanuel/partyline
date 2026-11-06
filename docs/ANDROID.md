# Build brief: Android app

Read `ARCHITECTURE.md` and `PROTOCOL.md` first. This session owns `apps/android`. Goal:
same as iOS — a crew phone that stays on the line for a shift, screen locked.

## Stack

- Kotlin, Jetpack Compose, minSdk 26 (Android 8), targetSdk latest.
- Deps: `io.livekit:livekit-android`, `androidx.core:core-telecom`, OkHttp (REST + WS),
  `kotlinx.serialization`, `androidx.security:security-crypto` (EncryptedSharedPreferences),
  `androidx.media:media` (MediaSession for headset buttons), CameraX + ML Kit barcode (QR).
- Distribution: signed APK installed directly, or Play internal testing track.

## Permissions and manifest

- `RECORD_AUDIO`, `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_WIFI_MULTICAST_STATE`
  (mDNS), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_PHONE_CALL`,
  `MANAGE_OWN_CALLS`, `POST_NOTIFICATIONS`, `VIBRATE`, `BLUETOOTH_CONNECT`, `CAMERA` (QR),
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (prompt once).
- `<service android:name=".call.IntercomService" android:foregroundServiceType="microphone|phoneCall" />`
- Notification channels: `intercom_call` (ongoing, low importance, no sound), `messages`
  (high importance), `signals` (high importance, custom tone).

## Modules (`apps/android/app/src/main/java/com/partyline/`)

| Module | Responsibility |
|---|---|
| `discovery/NsdDiscovery.kt` | `NsdManager.discoverServices("_partyline._tcp")`, resolve, read TXT (`id`, `name`, `fp`); acquire `WifiManager.MulticastLock` while discovering |
| `net/ServerClient.kt` | OkHttp with a `CertificatePinner` / custom `X509TrustManager` pinned to the saved sha256 per `serverId` (TOFU prompt on first connect); REST calls |
| `net/ControlSocket.kt` | OkHttp WebSocket `/api/ws`: auth, envelopes, ping 15 s, backoff reconnect, `Flow` of events |
| `model/` | `Device`, `Group`, `Settings`, `Message` per PROTOCOL §3.4; `RoutingEngine` per §5.1 |
| `audio/RoomController.kt` | LiveKit `Room` connect to `wss://host:8443/rtc`, publish mic once (muted), `setTrackSubscriptionPermissions`, enable/volume per routing, speaking → `status`. `AudioManager` mode `MODE_IN_COMMUNICATION`, prefer wired/Bluetooth SCO route, report route |
| `call/IntercomService.kt` | Foreground service started on join, stopped on leave. Owns `RoomController` + `ControlSocket` so they survive the Activity. Posts the ongoing `Notification.CallStyle.forOngoingCall` with actions Mute/Unmute, Speaker, Leave, and a "Quick reply" action opening the messages sheet |
| `call/TelecomController.kt` | `androidx.core.telecom.CallsManager`: register app, `addCall(...)` as outgoing self-managed call on join; handle `onSetActive`, `onSetInactive` (hold when a real call comes in → mute mic + pause playback), `onDisconnect` (leave), `onAnswer` n/a; routes via `CallEndpoint` |
| `input/MediaButtons.kt` | `MediaSessionCompat` active while live: headset play/pause = toggle mic (latch) or PTT down/up; volume keys handled by system call volume |
| `notify/MessageNotifier.kt` | Notifications for `message` and `signal` when backgrounded; vibration patterns; optional `TextToSpeech` readout |
| `ui/` | `DiscoveryScreen`, `JoinScreen` (code pad, name, QR), `CrewScreen`, `MessagesSheet`, `SettingsScreen`; Compose, phone-width only |
| `SessionViewModel.kt` | State machine `idle → discovering → joining → connecting → live → reconnecting`, binds to the service |

## Behaviors that are not optional

1. **Join = start foreground service + Telecom call.** The service must be in the
   foreground before LiveKit captures audio (Android 14+ enforces the `microphone` type).
2. **Mic track always published, PTT toggles mute.** Big button with `pointerInput`
   press/release; haptics via `HapticFeedbackConstants`. Latch = toggle. `forcedTalkMode`
   from server wins.
3. **Call notification Mute** is the hard mic mute, mirrored in the app.
4. **Routing** per PROTOCOL §5.1 on every roster/own-state change.
5. **Reconnect** keeps service + Telecom call alive; tones on disconnect/reconnect;
   rediscover via NSD when the WS cannot connect.
6. **Status**: battery via `BatteryManager`, route, rtt, speaking; max every 2 s.
7. **Battery optimization**: on first live session ask to ignore battery optimizations;
   detect vendor killers (Samsung "sleeping apps", Xiaomi autostart) and show a help link.
8. **Doze / Wi-Fi**: hold a `WifiManager.WifiLock(WIFI_MODE_FULL_LOW_LATENCY)` and a
   partial `WakeLock` while live, released on leave.
9. **Attention `signal`**: vibrate + tone even when speaker-muted.
10. **Launch with saved token** → `POST /api/session` → `CrewScreen`, auto-join (default on).

## Out of scope for v1

Quick Settings tile, volume-key PTT (possible later via `MediaSession` while locked),
Android Auto, Wear OS, FCM wake-up.

## Acceptance (Android session)

1. Discover host within 3 s (also on a phone that has mobile data on), join with code.
2. Lock the phone, 60 min in a pocket: audio both ways the whole time; test on at least one
   Samsung and one Pixel.
3. Incoming real call: intercom muted/held, resumes after hangup.
4. Wired and Bluetooth headsets route correctly; headset button toggles talk.
5. Admin mute shows lock; notification Mute action reflects it.
6. Kill the server for 20 s: service and call stay up, auto-resume.
7. Relaunch next day: connected with no join code, same group.
8. Message to the group arrives as a heads-up notification within 1 s.
9. Swipe the app away from Recents: the service keeps running and the call stays live
   (verify; if the vendor kills it, the battery-optimization help flow appears next launch).
