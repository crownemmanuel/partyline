# Build brief: Desktop (Tauri) — server, web client, desktop client

Read `ARCHITECTURE.md` and `PROTOCOL.md` first. This session owns `apps/desktop`,
`packages/web-client` and `packages/protocol`. It is the critical path: the phone sessions
need a running server to test against, so **get a joinable server up before polishing UI**.

## Stack

- **Tauri 2**, Rust backend, React + TypeScript + Vite frontend (the same `packages/web-client`).
- Rust crates: `tauri`, `tauri-plugin-shell` (sidecar), `tauri-plugin-store`, `axum`,
  `tokio`, `tokio-tungstenite` or axum's WS, `hyper` + `hyper-util` (reverse proxy for `/rtc`),
  `rustls` + `axum-server` (TLS), `rcgen` (self-signed cert), `rusqlite` (bundled),
  `mdns-sd`, `livekit-api` (AccessToken + RoomService client), `serde`/`serde_json`,
  `uuid`, `rand`, `sha2`, `tracing`.
- Frontend: `livekit-client`, `zustand`, `react-router`, Tailwind, `qrcode.react`.
- LiveKit server binary bundled as a sidecar for macOS arm64/x64, Windows x64, Linux x64.
  Pin one LiveKit version in `apps/desktop/livekit.version`.

## Rust backend modules (`apps/desktop/src-tauri/src/`)

| Module | Responsibility |
|---|---|
| `main.rs` | Tauri setup, commands: `host_start`, `host_stop`, `discover`, `get_local_info` |
| `config.rs` | App data dir, first-run generation of server id, cert, LiveKit key/secret, join code |
| `tls.rs` | `rcgen` cert with SANs: all LAN IPv4s, `partyline.local`, hostname; fingerprint |
| `livekit_sidecar.rs` | Write `livekit.yaml`, spawn sidecar, health check `:7880`, restart on crash, kill on exit |
| `livekit_admin.rs` | Token minting (grants per PROTOCOL §5), `MuteTrack`, `RemoveParticipant`, `UpdateParticipant` metadata |
| `db.rs` | SQLite schema + migrations: `server`, `groups`, `devices`, `messages`, `join_attempts` |
| `state.rs` | In-memory roster (`Device` + `live`), broadcast channel to WS sessions |
| `http.rs` | axum router: `/api/info`, `/api/join`, `/api/session`, `/api/messages`, `/healthz`, static web client, `/rtc` proxy |
| `ws.rs` | `/api/ws` sessions: auth, dispatch, validation (PROTOCOL §4), ack/error, ping/pong, token refresh timer |
| `mdns.rs` | Advertise `_partyline._tcp` with TXT; browse for other hosts in Join mode |
| `rate_limit.rs` | Join attempts: 5/min/IP then 5 min lockout; record for admin |

LiveKit sidecar config (generated):

```yaml
port: 7880
bind_addresses: ["127.0.0.1"]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: false
  node_ip: <LAN IP>          # re-generated if the IP changes; restart sidecar
keys:
  <apiKey>: <apiSecret>
room:
  auto_create: true
  empty_timeout: 86400
logging:
  level: warn
```

Behaviors to get right:

- **Join handling**: see PROTOCOL §2. Re-pairing an existing device keeps its row.
- **Admin mute** must call LiveKit `MuteTrack`; the roster flag alone is not enough.
- **Remove** = revoke token + `RemoveParticipant` + `kicked` message + close its WS.
- **Token refresh**: each WS session has a timer; send `token.refreshed` 5 min before expiry.
- **Server shutdown**: on app quit send `server.shutdown`, stop sidecar, unregister mDNS.
- **IP change** (laptop moves networks): regenerate cert SANs if a new IP is not covered
  (fingerprint changes → native apps will re-prompt; document), restart sidecar, re-advertise.
- **Roster broadcast**: coalesce `device.upsert` so a flood of `status` does not spam clients
  (max one upsert per device per 250 ms, except `micLive` which is immediate).

## Web client (`packages/web-client`)

One codebase, three uses: served to browsers, Tauri UI in Join mode, Tauri UI in Host mode
(Host mode adds the host panel: start/stop, join code, QR, sidecar health, firewall hint).

Screens:

1. **Home** (Tauri only): Host / Join. Join lists discovered servers (via Tauri command) and a
   manual field. Browser build skips this and goes to Join with the current origin as server.
2. **Join**: 6-digit code, name. Handles `/#join?code=…&fp=…`. Shows cert warning help.
3. **Crew** view (see ARCHITECTURE §10): big hold-to-talk button (pointer events, also
   Space bar on desktop), mic mute, speaker mute, reply-to-producer, messages sheet.
4. **Admin** view (when `me.isAdmin`): groups pane with Talk/Listen/volume and Talk-to-all;
   devices pane grouped by group with speaking dot, mute, solo, talk-to-device, battery,
   headset icon, menu (move, rename, force PTT, remove, forget); message composer with target
   picker and ack indicators; join code + QR + rotate + close joining; groups editor.
5. **Settings**: name, talk mode, audio input/output device, text-to-speech, leave/forget.

Audio: `livekit-client` with `autoSubscribe: true`, publish mic with
`{ echoCancellation, noiseSuppression, autoGainControl, dtx: true, red: true, audioPreset: speech }`,
implement the routing algorithm from PROTOCOL §5.1 in one `routing.ts` that both panes use.
Request `navigator.wakeLock` while connected. Detect no-headset via output device label where
available and warn.

Responsive: phone-width first (the browser client is used on phones in emergencies), then
the two-pane admin layout from ~900 px.

## Tauri as a client (its own audio)

Try the webview path first: macOS needs `com.apple.security.device.audio-input` in the
entitlements and `NSMicrophoneUsageDescription` in Info.plist; Windows WebView2 works.
**Test getUserMedia + a LiveKit publish in the first two days.** If it fails or is flaky on
macOS or Linux, switch the desktop's own audio to the `livekit` Rust SDK in the backend,
driven by Tauri commands (`rtc_connect`, `rtc_set_mic_live`, `rtc_set_subscription_permissions`,
`rtc_set_track_enabled`) and events for speaking/volume. Keep the web client's `livekit-client`
behind an interface so either backend plugs in.

## Mock server for the phone sessions

Ship early, in `packages/protocol/mock-server/` (Node): implements `/api/info`, `/api/join`,
`/api/session`, `/api/ws` with the sample messages, over HTTPS with the same self-signed cert
approach, and proxies `/rtc` to a locally installed `livekit-server --dev`. The phone sessions
can work against it until the Tauri host runs.

## Packaging

- macOS: `.dmg`, hardened runtime, microphone entitlement, not notarized for now (team-only).
- Windows: `.msi`, firewall rule prompt on first host start (explain in UI).
- Sidecar binaries downloaded by a `scripts/fetch-livekit.sh` step, checked by sha256.

## Acceptance (desktop session)

1. Fresh install → Host → join code and QR visible in under 5 s; `GET /api/info` answers.
2. Browser on a phone scans QR → joins → hears the desktop talking → desktop hears it.
3. Two browsers in Camera, one in Backstage: Backstage receives no Camera audio (check
   `getStats` inbound packets = 0 for those tracks).
4. Admin mute from the desktop silences a browser within 500 ms and the browser shows lock.
5. Remove → browser bounced to Join screen; its old token gets 403.
6. Quit and relaunch the host: same join code, same groups, browsers reconnect by themselves.
7. Rate limit: 6 wrong codes → 429 with Retry-After; attempts visible to admin.
8. `mdns-sd` advert visible from `dns-sd -B _partyline._tcp` (macOS) within 2 s of hosting.
