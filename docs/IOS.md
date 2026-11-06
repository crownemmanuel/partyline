# Build brief: iOS app

Read `ARCHITECTURE.md` and `PROTOCOL.md` first. This session owns `apps/ios`. Goal: a crew
phone that stays on the line for 8 hours in a pocket, screen locked, headset on.

## Stack

- Swift 5.10+, SwiftUI, iOS 16 minimum (CallKit outgoing calls, Network framework Bonjour).
- Swift Package deps: `LiveKit` (client-sdk-swift). Nothing else third-party; use
  `URLSession` for REST and `URLSessionWebSocketTask` for the control WS.
- Xcode project generated with XcodeGen or a plain `.xcodeproj`; bundle id `com.partyline.app`.
- Distribution: TestFlight internal testing (no App Review for internal testers) or Ad Hoc.

## Capabilities and Info.plist

- Background Modes: **Audio, AirPlay, and Picture in Picture** (`audio`) and **Voice over IP**.
- `NSMicrophoneUsageDescription`, `NSLocalNetworkUsageDescription`,
  `NSBonjourServices = ["_partyline._tcp"]`, `NSUserNotificationsUsageDescription`.
- Keychain access for `deviceId`, `deviceToken`, pinned fingerprint per `serverId`.

## Modules (`apps/ios/PartyLine/`)

| Module | Responsibility |
|---|---|
| `Discovery/BonjourBrowser.swift` | `NWBrowser(for: .bonjour(type: "_partyline._tcp", domain: nil))`, parse TXT (`id`, `name`, `fp`), resolve to host:port, publish a list of servers |
| `Net/ServerClient.swift` | REST (`/api/info`, `/api/join`, `/api/session`, `/api/messages`) with a `URLSessionDelegate` that **pins** the cert sha256 to the saved fingerprint for that `serverId` (TOFU prompt on first connect) |
| `Net/ControlSocket.swift` | `/api/ws`: auth, envelope coding, ping every 15 s, reconnect with backoff, publishes `welcome`/`device.upsert`/… as `AsyncStream` |
| `Model/Roster.swift` | `Device`, `Group`, `Settings`, `Message` Codable types exactly per PROTOCOL §3.4; `RoutingEngine` implementing §5.1 |
| `Audio/AudioSessionController.swift` | `AVAudioSession` category `.playAndRecord`, mode `.voiceChat`, options `[.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker off]`; route change + interruption handling; reports `outputRoute`/`headset` |
| `Audio/RoomController.swift` | LiveKit `Room` connect to `wss://host:8443/rtc`, publish mic once (muted), `setTrackSubscriptionPermissions`, enable/disable remote tracks + volume per routing, speaking detection → `status` |
| `Call/CallController.swift` | CallKit: `CXProvider` + `CXCallController`; on join `CXStartCallAction` (handle = server name), `reportOutgoingCall(connectedAt:)`; `performSetMutedCallAction` ↔ mic mute; `performEndCallAction` ↔ leave; `didActivate audioSession` → start LiveKit audio; hold/unhold on real calls |
| `Input/RemoteCommands.swift` | `MPRemoteCommandCenter` toggle play/pause = toggle mic (latch) or PTT press/release on headset button; setting to choose |
| `Notifications/MessageNotifier.swift` | Local `UNUserNotification` for `message` and `signal` when backgrounded; haptic + tone; optional `AVSpeechSynthesizer` readout |
| `UI/` | `DiscoveryView`, `JoinView` (code pad + name, QR scan via `DataScannerViewController`/AVFoundation), `CrewView`, `MessagesSheet`, `SettingsView` |
| `App/SessionCoordinator.swift` | State machine: `idle → discovering → joining → connecting → live → reconnecting`, owns all controllers |

## Behaviors that are not optional

1. **Join = start a CallKit call.** Nothing LiveKit-audio starts until
   `provider(_:didActivate:)` fires. Leaving = `CXEndCallAction`. If CallKit refuses (another
   call active), show why.
2. **Mic track always published, PTT toggles mute.** Big button: `.onLongPressGesture`
   with `pressing:` or a `DragGesture(minimumDistance: 0)`; haptic on down and up. In latch
   mode it is a toggle. `forcedTalkMode` from the server wins.
3. **Lock-screen Mute** (CallKit) is the hard mic mute, and shows as such in the app.
4. **Routing** per PROTOCOL §5.1, recomputed on every roster change and own state change.
5. **Reconnect** keeps the CallKit call alive. Play a short "disconnected" tone once, a
   "reconnected" tone once. Rediscover via Bonjour when the WS cannot connect.
6. **Status reports**: battery (`UIDevice.batteryLevel`, monitoring on), charging, route,
   rtt from LiveKit stats, speaking; max every 2 s.
7. **No headset warning**: if route is built-in speaker while live, show a banner.
8. **Attention `signal`**: `UINotificationFeedbackGenerator` + short tone through the
   call audio, even when speaker-muted.
9. **Launch with saved token** → `POST /api/session` → straight to `CrewView`, and
   **auto-join the call** (setting, default on) so the user just opens and locks.
10. Idle timer stays enabled; let the screen lock.

## Out of scope for v1 (do not start)

Live Activity, Control Center widget, Action Button intent, Apple Watch, PushKit. Leave
clear extension points: `CallController` already owns the call state these would read.

## Acceptance (iOS session)

1. Discover the host within 3 s, join with code, name appears in the desktop roster.
2. Lock the phone, put it in a pocket, 60 min: audio both ways the whole time, no
   `rtcConnected=false` events in the server log except planned ones.
3. Incoming real phone call: intercom goes on hold, call ends, intercom resumes by itself.
4. Headset button toggles talk; AirPods route in and out without the call dropping.
5. Admin mute: phone shows lock, PTT button disabled, lock-screen Mute is on.
6. Kill the server for 20 s: phone shows reconnecting, call stays, resumes without a tap.
7. Relaunch the app next day: connected with no join code, same group.
8. Message to Camera arrives as a lock-screen notification with vibration within 1 s.
9. Memory stable over 8 h (no leak in track handling), battery drain under ~8%/hour with
   screen off and a wired headset.
