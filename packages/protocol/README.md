# @partyline/protocol

Single source of truth for code: `src/index.ts` (types from PROTOCOL.md §3.4 plus every REST
and WS payload) and `samples/` (JSON from PROTOCOL.md §7, consistent ids across files,
`samples/fixtures.json` lists them). `scripts/gen-samples.mjs` regenerates the samples.

`mock-server/` is a runnable server for clients to test against; see its README.
