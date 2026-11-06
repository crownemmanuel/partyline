# PartyLine web client

React + TypeScript + Vite + Tailwind + livekit-client. One build, three uses: served to browsers by
the host, the Tauri UI in Host mode (loopback), and in Join mode (pinned loopback proxy). It always
talks to its own origin.

```bash
npm install
npm run build                 # dist/ — embedded into the Rust host, served by the mock
npm run dev                   # http://localhost:5173, proxies /api and /rtc to PARTYLINE_SERVER (default https://127.0.0.1:8443)
npm test                      # routing rule unit tests (PROTOCOL §5.1)
```

`src/lib/routing.ts` is the §5.1 rule (publisher permissions + receiver playback), `session.ts` the
controller/store, `control.ts` the WS client (backoff 1/2/4/8/15 s), `audio.ts` the LiveKit engine
behind an `AudioEngine` interface. `window.partyline` exposes state and `inboundPackets()` for tests.
