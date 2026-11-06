# PartyLine mock server

An in-memory (persisted to `.mock-data/state.json`) implementation of `docs/PROTOCOL.md` v1.
It is not a replay of canned bytes: joins, sessions, routing validation (§4), messages,
acks, signals, admin actions, rate limiting and token refresh all behave like the real host.
Use it until the Tauri host runs; the real host speaks the same protocol on the same port.

## Run

```bash
brew install livekit                     # once; provides livekit-server
cd packages/protocol/mock-server
npm install                              # once; only dependency is `ws`
node server.mjs --start-livekit          # HTTPS :8443 + livekit-server --dev on 127.0.0.1:7880
```

It prints the LAN URL, join code (default `483920`), cert fingerprint and the QR/deep link:

```
https://192.168.86.40:8443   join code 483920
fingerprint 3f9c…
join link   https://192.168.86.40:8443/#join?code=483920&fp=3f9c…&id=<server uuid>
```

Options: `--port=8443` `--code=483920` `--name="My mock"` `--data=<dir>` `--no-mdns`
`--start-livekit` (otherwise run `livekit-server --dev --bind 127.0.0.1 --node-ip <LAN IP>`
yourself) `--livekit=http://127.0.0.1:7880` `--token-ttl=3600` (shorten to test
`token.refreshed`) `--local-admin=false` `--all-admin`.

- **TLS**: self-signed P-256 cert made once in `.mock-data/` (SANs: LAN IPs, `partyline.local`,
  hostname, localhost). Fingerprint = sha256 of DER, lowercase hex, same as the real host.
  Delete `.mock-data/` to get a new server id + cert (tests your "fingerprint changed" path).
- **mDNS**: advertised with `dns-sd -R` on macOS (`avahi-publish` on Linux) as
  `_partyline._tcp` port 8443 with TXT `v=1 id=… name=… fp=…`. Check: `dns-sd -B _partyline._tcp`.
- **LiveKit**: `/rtc` (HTTP and WebSocket) is proxied to LiveKit. Give the SDK
  `wss://<host>:8443/rtc`; SDKs append their own `/rtc…` path and the proxy strips one `/rtc`
  prefix, so both `…/rtc/rtc?access_token=` and `…/rtc?access_token=` work. Media is UDP
  7882 (dev mode) on the LAN IP. Tokens are signed with `devkey`/`secret`.
- **Admin**: a device that joins from `127.0.0.1` is admin (that is how a browser on this Mac
  plays producer). Promote any device: `curl -k -X POST https://localhost:8443/mock/promote/<deviceId>`.
- **Static web client**: serves `packages/web-client/dist` at `/` when built.

## Test helpers (mock only, no auth)

```bash
curl -k https://localhost:8443/mock/state                         # whole state
curl -k -X POST https://localhost:8443/mock/message -d '{"to":"g:camera","text":"Cam 2 tighter"}'
curl -k -X POST https://localhost:8443/mock/signal  -d '{"to":"d:<deviceId>"}'
curl -k -X POST https://localhost:8443/mock/notice  -d '{"deviceId":"<id>","kind":"moved","text":"You were moved to Backstage"}'
curl -k -X POST https://localhost:8443/mock/talk    -d '{"deviceId":"<id>","micLive":true,"talkTargets":["g:camera"]}'
curl -k -X POST https://localhost:8443/mock/shutdown                # sends server.shutdown, closes sockets
```

Admin actions (mute, move, remove, rotate code) are easiest from the web client served at
`https://localhost:8443` on this Mac (it joins as admin), or send the `admin.*` WS messages.

## Protocol self-test

```bash
node test.mjs                                   # spins up its own mock on :18443, 29 checks
node test.mjs https://127.0.0.1:8443 <code>     # against a running server (rate-limit check last)
```

Sample messages for your own unit tests are in `../samples/` (`rest/*.json`, `ws/*.json`);
TypeScript types in `../src/index.ts`.
