# PartyLine Architecture

Status: design, nothing built. Date: 2026-11-05.

## 1. What we are building

A partyline intercom for one production team on one Wi-Fi network.

- **Groups** (channels): e.g. Camera, Backstage, Producer. Crew members belong to one group
  and talk/listen there. The producer can talk to any group, several groups, everyone, or one
  person, and chooses which groups to hear.
- **Desktop app is the server.** One laptop runs the Tauri app, which starts the media
  server, the control server, and hosts the web client. The same app is also a full client
  and the admin console.
- **Phones keep working with the screen locked**, in a pocket, for a whole shift. Done with
  CallKit on iPhone and the Telecom framework on Android, so the system treats the intercom
  as an ongoing phone call.
- **Join from anything on the network:** iPhone app, Android app, the desktop app on other
  computers, or a browser pointed at the server.
- **Dead simple UI.** Crew sees: group name, who is talking, mic button, speaker mute, a
  "reply to producer" button, messages. That is all.
- **Admin sees every device**, can mute it, remove it, move it to a group, rename it, and
  send text to a group or a device.
- **Devices are remembered.** A device that joined as "Camera 2" today is still Camera 2
  tomorrow, with no join code needed.

Target scale: 3 to 30 devices, one show at a time.

## 2. Components

```
                        ┌─────────────────────────── Desktop (Tauri 2) ───────────────────────────┐
                        │                                                                         │
                        │  Rust backend ("partyline-core")                                        │
                        │  ├─ Control server  (axum, HTTPS :8443)                                 │
                        │  │    REST /api/*, WebSocket /api/ws, static web client at /            │
                        │  │    reverse-proxies /rtc  →  LiveKit signaling                        │
                        │  ├─ State + SQLite   devices, groups, messages, settings, join code      │
                        │  ├─ LiveKit sidecar  livekit-server binary, ws 127.0.0.1:7880,          │
                        │  │                   media UDP 50000-50200 on the LAN interface         │
                        │  ├─ LiveKit admin API client  (tokens, mute track, remove participant)  │
                        │  ├─ mDNS advertiser  _partyline._tcp                                    │
                        │  └─ TLS              self-signed cert made on first run, kept forever   │
                        │                                                                         │
                        │  Webview UI = packages/web-client (same code as the hosted web client)  │
                        │  Admin console + local client                                           │
                        └─────────────────────────────────────────────────────────────────────────┘
                              ▲  HTTPS + WSS (control)          ▲  WebRTC / Opus (audio)
            ┌─────────────────┼────────────────────────────────┼──────────────────────────┐
     iPhone app          Android app                 Browser (web client)          Other desktops
   Swift + LiveKit     Kotlin + LiveKit             React + livekit-client       Tauri as client only
   CallKit             Core-Telecom + FG service    no background guarantee
```

### 2.1 Why LiveKit as the media server

- Open source, one binary, runs fine on a laptop. Ships as a Tauri **sidecar** per platform.
- Official SDKs for Swift, Kotlin, JavaScript and Rust, all on the same native WebRTC stack.
  The audio path is identical to a fully hand-written native app.
- It is an SFU: it forwards each person's audio stream only to the people who should hear
  it. No server-side mixing, so no extra latency and no mixing code to write.
- It has **server-enforced track subscription permissions**, which is exactly how we keep
  Backstage audio off the camera guys' phones (see §4).
- Server API lets the admin mute a track or remove a participant from the server side, so
  admin actions cannot be ignored by a client.

Rejected: writing our own SFU in Rust (months of work), mediasoup (Node runtime inside
Tauri is awkward), pure peer-to-peer mesh (does not scale past ~6 and makes routing a mess).

### 2.2 Why the control server is separate from LiveKit

LiveKit moves audio. Everything else (who is in which group, who may talk where, admin
commands, text messages, join codes, device memory) lives in our own small control server.
Reasons: it works before a device has joined the room, it persists, and it keeps the
routing logic in one place that all three clients read the same way.

### 2.3 Single-room design

One LiveKit room, always called `partyline`. Groups are **not** rooms. Every connected
device is in that one room with one microphone track. Group routing is done with
subscription permissions and client-side subscription (§4). Benefits:

- Switching what you talk to is instant: it changes a label, not a connection.
- One connection per device, so one CallKit/Telecom call. The lock-screen story stays simple.
- The producer hears several groups without several connections.

## 3. Data model

Persisted in SQLite on the server. Live state is in memory and pushed to clients.

```
Server
  id              uuid, generated once
  name            "Emmanuel's MacBook" (editable), shown in discovery
  cert            PEM + sha256 fingerprint, generated once
  livekit_key     API key/secret for the sidecar, generated once
  join_code       6 digits, current
  join_open       bool, admin can close joining entirely
  settings        default talk mode, etc.

Group                      (the user calls these groups; intercom people say channels)
  id              short slug, e.g. "camera"
  name            "Camera"
  color           for UI
  sort_order
  default_talk_mode   "ptt" | "latch" | null (device default)

Device                     (one row per physical phone / browser / desktop)
  id              uuid, generated by the device on first launch, stored securely on it
  display_name    "Camera 2"
  platform        ios | android | web | desktop
  app_version
  device_token_hash   sha256 of the long-lived token issued on join
  group_id        home group
  listen_group_ids    groups this device hears, default [group_id]
  can_talk_group_ids  groups this device may address, default [group_id]
  is_admin        bool
  forced_talk_mode    null | "ptt"       admin can force hold-to-talk for noisy people
  admin_muted     bool                   enforced server-side on the LiveKit track
  revoked         bool                   removed by admin; must re-join with a code
  created_at, last_seen_at

Message
  id, from_device_id, to  ("all" | "g:<group>" | "d:<device>"), text, created_at
  kind            "text" | "quick" | "signal"     signal = attention buzz, no text

LiveDeviceState            (in memory only, part of the roster pushed to clients)
  online          control WS connected
  rtc_connected   LiveKit connected
  mic_live        currently sending audio (unmuted / PTT held)
  speaker_muted   output muted locally
  talk_mode       "ptt" | "latch"
  talk_targets    ["g:camera", "d:<uuid>"]   where my voice goes when mic is live
  speaking        voice activity, for the "who is talking" indicator
  battery, charging, rtt_ms, platform details
```

Identity rules:

- LiveKit participant identity **is** `Device.id`. Participant display name is `display_name`.
- The device generates its id once and stores it in Keychain (iOS), Keystore-backed
  EncryptedSharedPreferences (Android), the Tauri store (desktop), localStorage (web, best
  effort: clearing site data makes a "new" device).
- Admin can **merge**: if someone reinstalls and shows up as a new device, admin moves it to
  the right group and deletes the stale row. No special merge feature in v1.

## 4. Audio routing

### 4.1 The rule

Each device has `listen_group_ids` (what I hear) and `talk_targets` (where my voice goes
right now). Targets are groups (`g:camera`) or single devices (`d:<id>`).

> **A hears B** when B's mic is live AND
> (B.talk_targets contains a group in A.listen_group_ids, OR B.talk_targets contains `d:A`)
> AND B is not admin-muted AND A has not locally muted B.

Examples with Producer (P), Camera 1 & 2 (C1, C2), Backstage (B1):

| P does | Who hears P | Who hears C1 when C1 talks |
|---|---|---|
| talk_targets = [g:camera] | C1, C2 | C1's default is [g:camera] → C2, and P if P listens to Camera |
| talk_targets = [g:camera, g:backstage] | C1, C2, B1 | same |
| talk_targets = [d:C2] | C2 only | same |
| P sets listen = [g:camera] | — | P hears Camera talk, hears nothing from Backstage |
| C1 holds "Reply to producer" | — | talk_targets temporarily [d:P] → only P hears C1 |

### 4.2 Enforcement, two layers

1. **Publisher-side, server-enforced.** When B's targets or the roster change, B's client
   computes the listener set from the rule and calls LiveKit
   `setTrackSubscriptionPermissions(allowedParticipants)`. LiveKit will refuse to forward
   B's audio to anyone else. A camera phone never receives Backstage packets.
2. **Receiver-side, local.** A subscribes to every track it is permitted to receive and
   applies its own speaker mute, per-device mute, and per-device volume. This is where the
   producer's "only hear these two" (solo) lives.

The control server is the source of truth for the roster, but it never touches audio
packets. If a client disagrees with the server (bug), the worst case is someone hears a
group they should not; permissions on the publisher side make that unlikely.

### 4.3 Talk modes

- **Hold to talk (PTT):** mic live while the button is held. Default for crew.
- **Latch:** tap to go live, tap to stop. Default for admin.
- **Mic mute:** hard mute. Overrides both. Shown as a locked state when the admin set it.
- **Speaker mute:** stop hearing. Messages and signals still arrive.

Implementation detail that matters for feel: the microphone track is **always published**
and PTT only toggles `track.mute`. LiveKit sends nothing while muted, and unmute is
near-instant, so the first syllable is not clipped. Never unpublish/republish on PTT.

### 4.4 Codec and latency settings

- Opus, 48 kHz, mono, 32–48 kbps, 20 ms frames, DTX on, FEC on.
- Echo cancellation, noise suppression, auto gain: on (WebRTC built-ins).
- Audio-only. No video, no simulcast. `red` (redundant encoding) on for Wi-Fi loss.
- Expected mouth-to-ear on a decent 5 GHz LAN: 60–120 ms.
- Headsets are assumed. The app warns when the phone is on speaker with no headset
  (echo risk), and admin sees a headset indicator per device.

### 4.5 Extras that fit the same pipe

- **Attention signal** ("call light"): admin or crew sends a `signal` to a group or device;
  the target vibrates and plays a short tone even if speaker-muted.
- **Speaking indicator**: voice activity reported locally, shown in the roster.
- **Program feed (later)**: the desktop can publish a second audio track from a chosen input
  (the show's program audio) that some groups listen to at low volume. Not v1.

## 5. Discovery and joining

### 5.1 Discovery

The desktop advertises over mDNS/DNS-SD:

```
Service type: _partyline._tcp.local
Port:         8443
TXT:          v=1  id=<server uuid>  name=<server name>  fp=<sha256 cert fingerprint, hex>
```

- iOS: `NWBrowser` (Bonjour). Needs `NSBonjourServices` = `_partyline._tcp` and
  `NSLocalNetworkUsageDescription` in Info.plist.
- Android: `NsdManager`.
- Desktop (as client): `mdns-sd` crate.
- Browser: cannot do mDNS. The desktop shows a **QR code and a URL** (`https://<lan ip>:8443`)
  on its screen. `https://partyline.local:8443` also works on Apple devices and most others.
- Every client also has a **manual address** field as fallback.

If more than one server is on the network, the client lists them by name. A desktop that
sees a server already running offers "Join <name>" or "Host a new one".

### 5.2 Join flow

```
Device                                   Server
  │  POST /api/join {joinCode, deviceId, displayName, platform}
  │─────────────────────────────────────────▶│  check code (rate limited), create/update Device
  │◀─────────────────────────────────────────│  {deviceToken, livekitToken, me, groups}
  │  WSS /api/ws  → {type:"auth", deviceToken}
  │─────────────────────────────────────────▶│
  │◀─────────────────────────────────────────│  {type:"welcome", roster, groups, settings}
  │  connect LiveKit at wss://<server>:8443/rtc with livekitToken
  │  publish mic (muted), set subscription permissions, start CallKit/Telecom call
```

- **Join code**: 6 digits, shown large on the desktop. Admin can rotate it any time or
  close joining. Server rate-limits attempts (5 per minute per IP, then a 5 minute lockout).
- **Device token**: 256-bit random, returned once, stored securely on the device, stored
  hashed on the server. It is what makes tomorrow's rejoin code-free.
- **Rejoin** (`POST /api/session` with the device token) returns a fresh LiveKit token and
  the device's saved group. No code needed unless the device was revoked.
- **LiveKit token**: JWT, 1 hour, grants `roomJoin`, `canPublish` (audio only),
  `canSubscribe`, identity = device id. Server pushes a refreshed token over the WS before
  expiry.
- The QR code encodes `https://<ip>:8443/#join?code=123456&fp=<fingerprint>` so a phone
  camera can join the web client in one scan, and native apps can parse the same link.

### 5.3 TLS on a LAN

Browsers only allow the microphone on HTTPS. There is no internet, so no public CA.

- Server generates a **self-signed ECDSA cert on first run**, valid 10 years, SANs for the
  LAN IP(s), `partyline.local` and the hostname. Stored and reused, so its fingerprint is
  stable.
- **Native apps pin the fingerprint.** They learn it from mDNS TXT or the QR link, show it
  on first connect ("Trust Emmanuel's MacBook?"), then refuse any other cert for that
  server id. Trust-on-first-use, like SSH.
- **Browsers** see a certificate warning once per device and the user clicks through. For a
  team-only tool this is acceptable. Documented upgrade path: own a domain, point a
  subdomain at the LAN IP, get a Let's Encrypt cert via DNS challenge, import it in the
  desktop settings. Then there is no warning.
- LiveKit signaling is reverse-proxied through the control server at `/rtc`, so there is
  **one cert and one TCP port**. Media is plain WebRTC (DTLS-SRTP, always encrypted) over UDP.

### 5.4 Ports and firewall

| Port | Proto | What | Exposed on LAN |
|---|---|---|---|
| 8443 | TCP | HTTPS: web client, REST, control WS, `/rtc` proxy | yes |
| 7880 | TCP | LiveKit signaling | 127.0.0.1 only |
| 7881 | TCP | LiveKit ICE/TCP fallback | yes |
| 50000–50200 | UDP | LiveKit media | yes |

macOS and Windows will show a firewall prompt the first time. The desktop app explains it.

## 6. Admin

Admin is a flag on a device. The hosting desktop is admin automatically. Admin can promote
any device (e.g. the producer's phone).

Admin can:

- See every device: name, platform, group, online/offline, mic live, speaker muted, talk
  mode, speaking now, battery, headset, round-trip time, app version, last seen.
- **Mute** a device's mic (enforced: server calls LiveKit MuteTrack; client shows a lock).
- **Remove** a device (server removes participant from the room, revokes the token).
- **Move** a device to a group; change its listen groups and talk permissions; rename it.
- **Force PTT** on a device or whole group.
- **Create / rename / delete groups.**
- **Send text** to all, a group, or a device. **Send an attention signal.**
- **Rotate the join code**, close/open joining, see failed join attempts.
- Save and load **show presets**: group list + which device goes where. v1.1.

Admin actions are **server-enforced where they matter** (mute, remove) and advisory
elsewhere (listen groups are applied by the client but the server also reflects them into
publisher permissions, so a device cannot hear what it is not allowed to).

## 7. Text messaging

Crew often cannot type (hands busy, phone in pocket), and the producer cannot always talk
(too noisy, or the mic would go to the wrong group). So:

- **Admin → group / device / all**: free text.
- **Crew → producer / own group**: free text plus **quick replies**: `OK`, `Standby`,
  `Go`, `Problem`, `Can't hear`, configurable list.
- **Attention signal**: no text, just buzz + tone. Crew can send it to the producer too.
- Delivery: over the control WS, stored in SQLite, so a device that was offline gets the
  last messages when it reconnects.
- On phones a message shows as a **notification on the lock screen** and a vibration.
  Optionally spoken into the earpiece with on-device text-to-speech (setting, off by default).
- Admin sees who has acknowledged (opened or tapped OK) a message. Simple read receipt.

## 8. Background and reliability

| | iPhone | Android |
|---|---|---|
| Stays alive, screen locked | CallKit outgoing call (`CXStartCallAction`) + `AVAudioSession` playAndRecord / voiceChat + `audio` background mode | Foreground service (`microphone` type) from day one; Core-Telecom self-managed call and `Notification.CallStyle` for correct behavior when a real call arrives |
| Lock-screen controls | System call screen: Mute (= mic off), speaker, End (= leave) | Call-style notification: Mute, Speaker mute, Leave, plus Reply/Quick buttons |
| Real phone call comes in | Intercom held, resumes after | same |
| Headset button | Toggles mic (latch) or acts as PTT while held, via MPRemoteCommandCenter | same via MediaSession |
| Wi-Fi drops | Keep the call alive, reconnect with backoff (1s, 2s, 4s… max 15s), show "reconnecting" and a tone | same |
| Server restarts | Rediscover via mDNS, rejoin with device token, no user action | same |

Known iOS limits: no custom lock-screen buttons without a Live Activity (v1.1), no
volume-button PTT (unsupported by Apple). Known Android limits: battery optimizations on
some vendors (Samsung, Xiaomi) can still kill foreground services; the app detects this and
asks the user to exempt it.

Web client: no background guarantee at all. It requests a screen wake lock and tells the
user to keep the tab visible. It is for laptops and for emergencies, not for pockets.

## 9. Desktop app roles

The Tauri app starts in one of two roles, chosen on the home screen:

- **Host**: starts LiveKit sidecar + control server, becomes admin, shows join code + QR,
  and is also a full client with its own mic/speakers.
- **Join**: discovers hosts, joins like any other client. Still gets admin tools if its
  device is flagged admin.

Only one host per network is expected. Host state (devices, groups, messages) is in SQLite
in the app data folder, so closing and reopening the app keeps everything.

Risk: WebRTC inside Tauri's webview. WebView2 (Windows) is Chromium and fine. WKWebView
(macOS) supports getUserMedia but needs the `com.apple.security.device.audio-input`
entitlement and `NSMicrophoneUsageDescription`; test early. WebKitGTK (Linux) is unreliable
for WebRTC. **Fallback decision already taken:** if the webview path is unreliable on any
platform, the desktop's own audio moves into the Rust backend using the `livekit` Rust SDK,
and the UI only sends commands to it. The web client served to browsers is unaffected.

## 10. UX, kept minimal

### Crew phone, main screen

```
┌──────────────────────────┐
│  CAMERA            ● live│  group name, connection dot
│  Emmanuel's MacBook      │
│                          │
│  Talking: Producer       │  who is speaking right now
│                          │
│  ┌────────────────────┐  │
│  │                    │  │
│  │   HOLD TO TALK     │  │  big, thumb-sized, haptic on press/release
│  │                    │  │  (or TALK ON/OFF when latch mode)
│  └────────────────────┘  │
│                          │
│  [🔇 mic]  [🔈 speaker]  │  hard mutes, red when on
│  [Reply to producer]     │  hold: targets only the producer
│  [💬 messages (2)]       │  sheet with quick replies
└──────────────────────────┘
```

Settings (one screen): name, server, talk mode, headset check, text-to-speech, leave.

### Producer / admin (desktop, tablet, or web)

Two panes. Left: groups as rows with **Talk** (hold or latch), **Listen** toggle, volume.
A **Talk to all** button. Right: devices grouped by group, each with speaking indicator,
mute, solo, talk-to-this-device, battery, and a menu (move, rename, force PTT, remove).
Top: join code + QR, message composer with target picker.

### First run

Phone: open → "Looking for PartyLine…" → tap the server → enter 6-digit code (or scan QR)
→ type your name → you are in Camera (or whatever admin assigns) → lock the phone.
Second day: open → connected, nothing to do.

## 11. Security summary

- Join code gates first contact; rate limited.
- Device token (hashed at rest) for every later connection; admin can revoke.
- LiveKit tokens are short-lived and scoped (publish audio only, one room).
- All control traffic is TLS; native apps pin the server cert; media is DTLS-SRTP.
- No internet required, nothing leaves the LAN. No accounts, no cloud.
- Admin-only messages are rejected server-side for non-admin devices.
- Not in scope: defending against someone already on your Wi-Fi who is also a skilled
  attacker. Use your own access point with a password.

## 12. Decisions log

| Decision | Choice | Why |
|---|---|---|
| Media server | LiveKit as Tauri sidecar | SDKs on all four platforms, SFU, server-enforced permissions, one binary |
| Rooms | One room, groups by routing | instant switching, one call per device |
| Phone background | CallKit / Telecom from day one | reliability first, team-only app, system call UI is enough |
| Phone apps | Fully native (Swift, Kotlin) | tiny UI, all hard parts are native anyway, no bridge layer |
| Desktop | Tauri 2, Rust backend hosts everything | one install is the whole server; web client shared with browsers |
| Web client | React + TypeScript + Vite, livekit-client | also used as Tauri UI; most common stack |
| Control transport | REST for join/session, WebSocket JSON for everything live | simple, debuggable, works on all platforms |
| Routing enforcement | Publisher sets LiveKit subscription permissions | server-enforced without writing an SFU |
| TLS | Self-signed, stable, pinned by native apps | no internet dependency; browsers click through once |
| Persistence | SQLite via rusqlite | single file, zero setup |
| Identity | Device-generated UUID + server-issued token | code-free rejoin, admin can revoke |
| Push notifications | None in v1 | user starts the session; no "ring a closed app" need yet |

## 13. Not in v1 (parked, in rough priority)

1. iOS Live Activity with mute/talk buttons; Control Center widget; Action Button shortcut.
2. Program audio feed into a group (IFB).
3. Show presets (save/load group assignments).
4. Remote participants over the internet (needs TURN + a public address).
5. Call signal to a closed app (needs PushKit/FCM).
6. Recording of a group.
7. Apple Watch / Android Auto surfaces (come mostly free with CallKit/Telecom; verify later).

## 14. Acceptance tests for the whole system

1. Three phones (2 iOS, 1 Android) + desktop host, all locked in pockets, 8 hours: no
   dropouts longer than the reconnect window, no app death.
2. Real phone call to a locked iPhone during the shift: intercom holds and resumes.
3. Walk between two access points of the same Wi-Fi: reconnect under 5 s.
4. Kill and restart the desktop app: phones reconnect by themselves, same groups.
5. Producer talks to Camera: Backstage phone shows zero inbound audio packets (check in
   LiveKit stats). Talk to one device: only that device hears.
6. Admin mutes a phone: audio stops within 500 ms, phone shows lock, user cannot unmute.
7. Admin removes a phone: it disconnects and cannot rejoin without a new code.
8. Twenty devices connected: desktop CPU under 30%, mouth-to-ear under 150 ms.
9. Wrong join code 6 times: lockout, admin sees the attempts.
10. Browser join via QR on an iPhone camera: in the group within 30 s including the cert warning.
