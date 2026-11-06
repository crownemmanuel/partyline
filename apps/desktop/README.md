# PartyLine desktop (Tauri 2)

The host: Rust control server + LiveKit sidecar + mDNS, with `packages/web-client` as its UI.

## Run

```bash
scripts/fetch-livekit.sh                         # once: sidecar binary (macOS: from the Homebrew bottle)
npm --prefix packages/web-client install && npm --prefix packages/web-client run build
cd apps/desktop && npm install
npx tauri build --debug --bundles app            # → src-tauri/target/debug/bundle/macos/PartyLine.app
npm run build:installer                          # release installers, no update files
```

CI builds macOS, Windows and Linux on every push to `main`; tags publish releases that installed
apps update from. See [docs/RELEASES.md](../../docs/RELEASES.md).

Headless host (same server, no window — handy for phones and CI):

```bash
cd apps/desktop/src-tauri && cargo run --bin partyline-host
```

Env overrides (to run next to the mock or another host): `PARTYLINE_DATA`, `PARTYLINE_PORT` (8443),
`PARTYLINE_LOOPBACK_PORT` (8442), `PARTYLINE_LIVEKIT_PORT` (7880), `PARTYLINE_LIVEKIT_TCP_PORT` (7881),
`PARTYLINE_UDP_START`/`_END` (50000–50200), `PARTYLINE_LIVEKIT_BIN`, `PARTYLINE_NO_MDNS=1`.
`PARTYLINE_JOIN=<host:port> [PARTYLINE_JOIN_FP=<fp>]` runs only the join-mode proxy on :8441.

Data: `~/Library/Application Support/app.partyline.desktop/host/` (SQLite `partyline.db`, `cert.pem`,
`livekit.yaml`, `livekit.log`). The app remembers its last role in `…/app.partyline.desktop/prefs.json`
and resumes it on launch (host keeps the same join code, groups and certificate).

## How the webview gets audio

WKWebView will not accept the self-signed certificate, so the desktop's own UI never talks to
`https://…:8443`:

- **Host**: the server also listens on `http://127.0.0.1:8442` (loopback only). The window navigates
  there. `http://127.0.0.1` is a secure context, so getUserMedia works; `/rtc` on that listener
  proxies to LiveKit. Loopback requests are the host's own console: `/api/info` adds
  `"localHost": true`, `/api/join` needs no code and makes the device admin.
- **Join** (desktop as a client of another host): a loopback proxy on `:8441` forwards everything
  to the remote host over TLS pinned to its fingerprint (from mDNS TXT, or shown for approval when
  typed by hand). Wrong certificate → refused.

Verified on macOS 26 (arm64): getUserMedia + LiveKit publish inside the webview works (LiveKit shows
the host's `AUDIO/MICROPHONE/mic` track). The Rust-SDK audio fallback was not needed; the web client's
audio is behind `AudioEngine` (`packages/web-client/src/lib/audio.ts`) if it ever is.

## Tests

```bash
cd apps/desktop/src-tauri && cargo test --lib
node packages/protocol/mock-server/test.mjs https://127.0.0.1:8443 <code>      # 29 protocol checks (admin via ADMIN_BASE=http://127.0.0.1:8442)
node scripts/e2e/acceptance.mjs --url=https://<lan ip>:8443 --code=<code> --admin-url=http://127.0.0.1:8442
node scripts/e2e/restart.mjs --url=… --code=… --restart="<cmd that quits and relaunches the host>"
```

`scripts/e2e` uses Playwright with system Chrome and fake microphones (`npm install` there first).

## Module map (`src-tauri/src`)

`lib.rs` Tauri commands (`host_start`, `host_stop`, `discover`, `probe_server`, `join_remote`, `go_home`,
`get_local_info`) · `host.rs` start/stop, IP-change watcher · `config.rs` first run · `tls.rs` cert,
LAN IPs, pinned verifier · `livekit_sidecar.rs` · `livekit_admin.rs` tokens + RoomService Twirp
(hand-rolled HS256/JSON instead of the `livekit-api` crate: four calls, no extra HTTP stack) ·
`db.rs` · `state.rs` world, routing rules, coalesced upserts · `http.rs` REST, static, `/rtc` proxy ·
`ws.rs` sessions · `mdns.rs` · `rate_limit.rs` · `proxy.rs` join-mode proxy.
