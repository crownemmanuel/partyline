# PartyLine

A low-latency partyline intercom for a small production team on one Wi-Fi network.
Phones in pockets, headsets on, screen locked, and a producer who can talk to any group
or any single person.

Desktop host for macOS, Windows and Linux ([download](https://github.com/crownemmanuel/partyline/releases/latest)),
iPhone and Android apps, and a browser client.

## Documents

| File | What it is | Who reads it |
|---|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The whole system: components, audio routing, security, discovery, data model, UX, decisions | Everyone, first |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The contract between server and every client: REST, WebSocket messages, LiveKit mapping | Everyone, before writing code |
| [docs/DESKTOP.md](docs/DESKTOP.md) | Build brief for the Tauri desktop app (server + web client + desktop client) | Desktop session |
| [docs/IOS.md](docs/IOS.md) | Build brief for the iPhone app | iOS session |
| [docs/ANDROID.md](docs/ANDROID.md) | Build brief for the Android app | Android session |
| [docs/RELEASES.md](docs/RELEASES.md) | CI builds, cutting a release, desktop auto-updates, signing key | Whoever ships |

## Build order

Three sessions build in parallel, one per platform. They can only do that because
`PROTOCOL.md` is fixed first. **Any change to the protocol is made in PROTOCOL.md before
it is made in code**, and the other two sessions are told.

The desktop session has the most work (it is the server). The phone sessions can start
against a mock server that replays the sample messages in PROTOCOL.md until the real one
is up.

## Planned repo layout

```
PartyLine/
  README.md
  docs/                      design documents (this set)
  packages/
    protocol/                JSON samples + TypeScript types, the single source of truth
    web-client/              React web client, also the UI inside the Tauri app
  apps/
    desktop/                 Tauri 2 app: Rust server, mDNS, LiveKit sidecar, hosts web-client
    ios/                     Swift / SwiftUI app
    android/                 Kotlin / Jetpack Compose app
```
