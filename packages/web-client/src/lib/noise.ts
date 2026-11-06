// On-device voice isolation: DeepFilterNet3 (WASM SIMD, weights baked in) as a LiveKit audio
// processor. Runs fully offline; the ~34 MB wasm is served by the host and only fetched the
// first time the filter is switched on (then cached immutably by the browser).
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import workletSrc from "@lofcz/deepfilternet-web/worklet?raw";
import wasmUrl from "@lofcz/deepfilternet-web/df_bg.wasm?url";

/** DeepFilterNet runs at 48 kHz; the mic's AudioContext must match. */
export const NOISE_SAMPLE_RATE = 48_000;

export function voiceIsolationSupported() {
  return typeof AudioWorkletNode !== "undefined" && typeof WebAssembly === "object" && WebAssembly.validate(SIMD_PROBE);
}
// smallest module using a v128 op: fails to validate where wasm SIMD is missing (Safari < 16.4)
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

// AudioWorkletGlobalScope has no TextDecoder or crypto, which the package's wasm-bindgen glue
// touches at load (and only uses for error strings / RNG seeding), so it would never register.
const POLYFILL = `
if (typeof TextDecoder === "undefined") globalThis.TextDecoder = class { decode(b) { let s = ""; if (b) for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; } };
if (typeof crypto === "undefined") globalThis.crypto = { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } };
`;
const PROCESSOR = "deepfilternet-processor";

let wasmModule: Promise<WebAssembly.Module> | null = null;
const loadedContexts = new WeakSet<BaseAudioContext>();

async function prepare(ctx: AudioContext) {
  wasmModule ??= fetch(wasmUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`model download failed (${r.status})`);
      return r.arrayBuffer();
    })
    .then((b) => WebAssembly.compile(b))
    .catch((e) => {
      wasmModule = null; // let the next attempt retry
      throw e;
    });
  if (!loadedContexts.has(ctx)) {
    const url = URL.createObjectURL(new Blob([POLYFILL, workletSrc], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    loadedContexts.add(ctx);
  }
  return wasmModule;
}

export class VoiceIsolation implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "voice-isolation-dfn3";
  processedTrack?: MediaStreamTrack;
  private nodes: AudioNode[] = [];

  init = (opts: AudioProcessorOptions) => this.build(opts);
  restart = async (opts: AudioProcessorOptions) => {
    this.teardown();
    await this.build(opts);
  };
  destroy = async () => this.teardown();

  private async build({ track, audioContext: ctx }: AudioProcessorOptions) {
    if (!ctx) throw new Error("no audio context");
    const module = await prepare(ctx);
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    // full strength: no attenuation cap, so steady noise (fans, crowd, generators) goes to silence
    const node = new AudioWorkletNode(ctx, PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { wasmModule: module, attenuationLimit: 100 },
    });
    const dest = ctx.createMediaStreamDestination();
    source.connect(node).connect(dest);
    this.nodes = [source, node, dest];
    this.processedTrack = dest.stream.getAudioTracks()[0];
  }

  private teardown() {
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this.processedTrack?.stop();
    this.processedTrack = undefined;
  }
}
