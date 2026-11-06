# PartyLine for iPhone

Crew intercom client. Swift 5.10 / SwiftUI, iOS 16+, LiveKit Swift SDK (SPM, resolved 2.19.0),
CallKit. Build brief: `docs/IOS.md`. Contract: `docs/PROTOCOL.md`.

## Build

```bash
brew install xcodegen          # once
cd apps/ios
xcodegen generate              # writes PartyLine.xcodeproj from project.yml
xcodebuild build -project PartyLine.xcodeproj -scheme PartyLine \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build/dd -clonedSourcePackagesDirPath build/spm
xcodebuild test  -project PartyLine.xcodeproj -scheme PartyLine \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build/dd -clonedSourcePackagesDirPath build/spm
```

### Voice isolation (DeepFilterNet)

```bash
scripts/build-libdf.sh         # needs rustup; builds libDF for iPhone + Apple-silicon Simulator
```

This writes `Vendor/DeepFilter.xcframework`, copies `DeepFilterNet3_onnx.tar.gz` into
`PartyLine/Resources/`, rewrites `libdf.yml` to link it and regenerates the project. Without it the
app still builds and the Voice isolation button runs WebRTC noise suppression ("basic").

For a device build, open `PartyLine.xcodeproj`, set your team on the PartyLine target
(bundle id `com.partyline.app`), and run. Background modes `audio` + `voip` are in the plist.

Tests decode and encode the shared samples in `packages/protocol/samples/` (skipped if that
folder is missing) and cover the §5.1 routing table.

## Layout (`PartyLine/`)

| Folder | What |
|---|---|
| `App/` | `PartyLineApp`, `SessionCoordinator` (state machine, owns everything), `Storage` (Keychain + prefs) |
| `Discovery/` | `BonjourBrowser`: `_partyline._tcp` browse, TXT parse, resolve to IPv4 |
| `Net/` | `ServerClient` (REST), `ControlSocket` (WS), `Pinning` (TOFU fingerprint pin), `PinnedTLSProxy` |
| `Model/` | `Roster` types per §3.4, `Wire` (envelope, REST bodies, join link), `RoutingEngine` (§5.1, pure) |
| `Audio/` | `AudioSessionController` (session + routes), `RoomController` (LiveKit) |
| `Call/` | Intercom session lifecycle and Lock Screen Live Activity |
| `Input/` | `RemoteCommands` (headset button) |
| `Notifications/` | `MessageNotifier` + synthesized `Tones` |
| `Resources/` | `Info.plist`, `Assets.xcassets` (AppIcon + Logo, both from `packages/protocol/assets/app-icon-1024.png`) |
| `Shared/` (top level) | Live Activity model + mic intent, compiled into the app and `Widgets/` |
| `Widgets/` (top level) | `PartyLineWidgets` extension: lock-screen + Dynamic Island views |
| `UI/` | Discovery, Join, Crew, Messages (button, panel, pop-up), Settings, QR scanner |

## Things worth knowing

- **LiveKit through a pinned loopback proxy.** The LiveKit Swift SDK opens its signaling
  WebSocket with its own `URLSession` and has no trust hook, so it rejects the host's self-signed
  cert. `PinnedTLSProxy` listens on `127.0.0.1:<random>` and pipes bytes to `host:8443` over TLS
  that only accepts the pinned fingerprint. LiveKit is given `ws://127.0.0.1:<port>/rtc`.
  Media (UDP, DTLS-SRTP) does not go through it. ATS allows this via `NSAllowsLocalNetworking`.
- **Audio session ownership.** On iOS 16.2 and later, joining activates a
  `.playAndRecord` voice-chat session with background audio. Pressing the side button locks
  the phone while the intercom continues. Audio interruptions put the mic on hold.
  On iOS 16.0–16.1 devices, CallKit supplies the system call controls.
- **Mic always published, PTT toggles mute.** LiveKit's full reconnect does not re-publish muted
  tracks, so `RoomController` re-publishes the mic after `didCompleteReconnectWithMode`.
- **Publisher permissions** go by participant *sid* (that's what the Swift SDK takes), mapped
  from identity = deviceId; recomputed on every participant join.
- **Headset button** is a talk toggle in every mode: `MPRemoteCommandCenter` gives presses, not holds.
- **Fail-fast LiveKit connect.** 5 s transport timeouts plus app-level retry (0.5, 2, 4, 8, 15 s).
  In the Simulator, roughly half of the relaunches after a kill hang on the first ICE attempt
  (also seen connecting straight to LiveKit, without the proxy); the retry then connects in ~0.1 s.
- **Voice isolation** (one button, ON by default, `Storage.voiceIsolation`): with libDF linked,
  `VoiceIsolationProcessor` runs DeepFilterNet3 (48 kHz, 100 dB limit) as LiveKit's
  `capturePostProcessingDelegate`, after AEC/AGC, with WebRTC noise suppression off. Toggling it
  attaches/detaches instantly. In basic mode a toggle re-publishes the mic (capture options are
  per track). Apple's own Voice Isolation mic mode can't be set in code; Settings shows it and
  opens the system picker.
- **Messages**: full-width "💬 Messages" button (unread badge) at the bottom of the crew screen opens `MessagesPanel` in place, as a card over the bottom of the screen.
  Live messages from others pop up (`MessagePopup`, top of `RootView`) until dismissed; history
  from `welcome` never pops up. `message.ack` goes out only when a message is seen (pop-up
  closed/answered, panel opened, or arriving while the panel is open). Reply targets follow
  `MessageRules.replyTarget`. Backgrounded: notification with inline Reply and Close actions.
- **Live Activity** (iOS 16.2+): `Call/LiveActivityController` starts one when on the line and
  ends it on leave; the `PartyLineWidgets` extension draws it on the lock screen and in the
  Dynamic Island (mic Muted / Live / Locked, who is talking, latest message, unread count).
  On iOS 17+ the mic button sends an explicit mute or unmute to the active intercom.
  A paired Apple Watch (watchOS 11+, iPhone on iOS 18+) shows the group and mic state in
  the Smart Stack. Tap the mic to control the iPhone intercom. Producer mute locks the control.
  Updates are local and coalesced (300 ms);
  the active intercom uses the `audio` background mode while locked.
  Model shared by both targets: `Shared/PartyLineActivity.swift`.
- Debug aids (env vars on launch, e.g. `SIMCTL_CHILD_PL_LK_DEBUG=1 xcrun simctl launch …`):
  `PL_LK_DEBUG` = LiveKit SDK logs; `PL_DIRECT_LK=ws://127.0.0.1:7880` (Debug + Simulator only)
  bypasses the proxy.

## Shipping with TestFlight

Nothing here has been uploaded. Every step below uses your Apple account; do them when ready.

**Once**
1. Join the Apple Developer Program (paid; a free Personal Team cannot use TestFlight).
2. Pick a bundle ID you own, e.g. `com.<you>.partyline`, and set `PRODUCT_BUNDLE_IDENTIFIER` in
   `project.yml` (`com.partyline.app` may already be registered to someone else). Set
   `DEVELOPMENT_TEAM` to your team ID, then `xcodegen generate`.
3. App Store Connect → Apps → **+ New App**: iOS, that bundle ID, name "PartyLine", any SKU.
4. App Store Connect → the app → **TestFlight**: fill in Test Information (beta description,
   feedback email, review contact). For Beta App Review, explain that the app needs a PartyLine
   host on the same Wi-Fi, and offer a short screen recording or a reachable demo host.

**Each build**
1. Bump `CURRENT_PROJECT_VERSION` in `project.yml` (every upload needs a new build number;
   bump `MARKETING_VERSION` for a new version), then `xcodegen generate`.
2. Archive and upload, either in Xcode (Product → Archive → Organizer → Distribute App →
   TestFlight & App Store) or from the command line:
   ```bash
   xcodebuild archive -project PartyLine.xcodeproj -scheme PartyLine -configuration Release \
     -destination 'generic/platform=iOS' -archivePath build/PartyLine.xcarchive -allowProvisioningUpdates
   xcodebuild -exportArchive -archivePath build/PartyLine.xcarchive -exportPath build/export \
     -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates
   ```
   with an `ExportOptions.plist` containing `method` = `app-store-connect`, `destination` =
   `upload` and your `teamID`. Xcode must be signed in to the account (Settings → Accounts).
3. When the build finishes processing, add it to an **External Testing** group and turn on the
   **Public Link**. The first external build goes through Beta App Review (usually under a day).
4. Paste the public link into the host: Groups & server → "iPhone app link (TestFlight)". The
   host's "Get the app" page then shows TestFlight steps.

**What review looks at** (all in `project.yml` → Info.plist)
- Microphone: "PartyLine sends your voice to your crew when you talk."
- Local network + Bonjour `_partyline._tcp`: finds and connects to the host on this Wi-Fi.
- Camera: scanning the join QR code.
- Background mode `audio`: the intercom keeps playing and transmitting with the screen locked
  (the core use case; worth saying so in the review notes).
- Background mode `voip`: Apple ties this to VoIP pushes (PushKit), which PartyLine doesn't use.
  CallKit supplies controls on older devices running iOS 16.0–16.1.
- Export compliance: `ITSAppUsesNonExemptEncryption = NO` (only standard TLS/DTLS-SRTP).
- Privacy manifest: `Resources/PrivacyInfo.xcprivacy` (no tracking, no collected data,
  UserDefaults reason CA92.1). LiveKit ships its own.
- Without `scripts/build-libdf.sh`, voice isolation is "basic"; the build is still shippable.

The host's "Get the app" QR (`https://host:port/#install&code=…&fp=…&id=…`) also works as a
join link inside the app: scan or paste it on the server screen.
