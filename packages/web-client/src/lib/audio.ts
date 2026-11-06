// Audio engine behind an interface (DESKTOP.md "Tauri as a client"): the web client uses
// livekit-client; a Rust-SDK engine driven by Tauri commands could implement the same shape.
import {
  ConnectionState,
  LocalAudioTrack,
  ParticipantEvent,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  createLocalAudioTrack,
  type RemoteTrack,
} from "livekit-client";
import { NOISE_SAMPLE_RATE, VoiceIsolation, voiceIsolationSupported } from "./noise";

export type RtcState = "disconnected" | "connecting" | "connected" | "reconnecting";
/** off · loading the model · DeepFilterNet active · browser's built-in suppression only */
export type NoiseState = "off" | "loading" | "on" | "basic";

export interface AudioEngineEvents {
  state(s: RtcState): void;
  localSpeaking(speaking: boolean): void;
  activeSpeakers(ids: string[]): void;
  /** a remote participant's track (un)subscribed, so playback must be re-applied */
  tracksChanged(): void;
  playbackBlocked(blocked: boolean): void;
  micError(message: string): void;
  noiseState(state: NoiseState, detail?: string): void;
}

export interface AudioEngine {
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  setMicLive(live: boolean): Promise<void>;
  setAllowedListeners(identities: string[]): void;
  setPlayback(identity: string, enabled: boolean, volume: number): void;
  remoteIdentities(): string[];
  startAudio(): Promise<void>;
  setInputDevice(id: string): Promise<void>;
  setOutputDevice(id: string): Promise<void>;
  setNoiseFilter(on: boolean): Promise<void>;
  rttMs(): number | null;
  /** inbound RTP packets per remote identity (acceptance test: 0 for routed-away groups) */
  inboundPackets(): Promise<Record<string, number>>;
}

/** wss://host:8443/rtc from the relative "/rtc" the server returns */
export function resolveLivekitUrl(u: string) {
  const url = new URL(u, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  return url.toString().replace(/\/$/, "");
}

export class LiveKitEngine implements AudioEngine {
  private room: Room;
  private mic: LocalAudioTrack | null = null;
  private micLive = false;
  private allowed: string[] | null = null;
  private play = new Map<string, { enabled: boolean; volume: number }>();
  private sink = document.createElement("div");
  private noiseCtx: AudioContext | null = null;
  private noiseWanted: boolean;
  private noiseBusy: Promise<void> = Promise.resolve();

  constructor(private ev: AudioEngineEvents, private inputDeviceId: string | null, outputDeviceId: string | null, noiseFilter = true) {
    this.noiseWanted = noiseFilter;
    this.sink.style.display = "none";
    document.body.appendChild(this.sink);
    this.room = new Room({
      adaptiveStream: false,
      dynacast: false,
      stopLocalTrackOnUnpublish: true,
      disconnectOnPageLeave: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      audioOutput: outputDeviceId ? { deviceId: outputDeviceId } : undefined,
      publishDefaults: { dtx: true, red: true, audioPreset: { maxBitrate: 32_000 }, forceStereo: false, stopMicTrackOnMute: false },
      reconnectPolicy: { nextRetryDelayInMs: (ctx) => [500, 1000, 2000, 4000, 8000, 15000][Math.min(ctx.retryCount, 5)] },
    });
    const r = this.room;
    r.on(RoomEvent.ConnectionStateChanged, (s) => {
      const map: Record<string, RtcState> = {
        [ConnectionState.Connected]: "connected",
        [ConnectionState.Connecting]: "connecting",
        [ConnectionState.Reconnecting]: "reconnecting",
        [ConnectionState.SignalReconnecting]: "reconnecting",
        [ConnectionState.Disconnected]: "disconnected",
      };
      this.ev.state(map[s] ?? "disconnected");
    });
    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.dataset.identity = p.identity;
      this.sink.appendChild(el);
      this.apply(p.identity);
      this.ev.tracksChanged();
    });
    r.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
      this.ev.tracksChanged();
    });
    r.on(RoomEvent.ParticipantConnected, () => this.ev.tracksChanged());
    r.on(RoomEvent.ParticipantDisconnected, () => this.ev.tracksChanged());
    r.on(RoomEvent.ActiveSpeakersChanged, (sp) => this.ev.activeSpeakers(sp.filter((p) => p.identity !== r.localParticipant.identity).map((p) => p.identity)));
    r.on(RoomEvent.AudioPlaybackStatusChanged, () => this.ev.playbackBlocked(!r.canPlaybackAudio));
    r.on(RoomEvent.MediaDevicesError, (e) => this.ev.micError(e.message));
    r.localParticipant.on(ParticipantEvent.IsSpeakingChanged, (s) => this.ev.localSpeaking(s));
    r.on(RoomEvent.Reconnected, () => this.reapplyLocal());
    r.on(RoomEvent.TrackMuted, (pub, p) => {
      // server-side admin mute (MuteTrack) arrives as a mute of our own track
      if (p === r.localParticipant && pub.source === Track.Source.Microphone && this.micLive) this.micLive = false;
    });
  }

  async connect(url: string, token: string) {
    await this.room.connect(resolveLivekitUrl(url), token, { autoSubscribe: true });
    try {
      this.mic = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        deviceId: this.inputDeviceId ?? undefined,
      });
      await this.room.localParticipant.publishTrack(this.mic, {
        source: Track.Source.Microphone,
        name: "mic",
        dtx: true,
        red: true,
        audioPreset: { maxBitrate: 32_000 },
        stopMicTrackOnMute: false,
      });
      if (!this.micLive) await this.mic.mute();
    } catch (e: any) {
      this.ev.micError(e?.message ?? String(e));
    }
    // don't hold up joining on the model download
    void this.setNoiseFilter(this.noiseWanted);
    this.reapplyLocal();
    this.ev.playbackBlocked(!this.room.canPlaybackAudio);
    this.ev.tracksChanged();
  }

  private reapplyLocal() {
    if (this.allowed) this.setAllowedListeners(this.allowed);
  }

  async disconnect() {
    await this.room.disconnect();
    this.mic = null;
    void this.noiseCtx?.close().catch(() => {});
    this.noiseCtx = null;
    this.sink.innerHTML = "";
  }

  async setMicLive(live: boolean) {
    this.micLive = live;
    if (live) void this.noiseCtx?.resume().catch(() => {}); // iOS starts contexts suspended until a tap
    if (!this.mic) return;
    if (live) await this.mic.unmute();
    else await this.mic.mute();
  }

  setAllowedListeners(identities: string[]) {
    this.allowed = identities;
    if (this.room.state !== ConnectionState.Connected) return;
    this.room.localParticipant.setTrackSubscriptionPermissions(
      false,
      identities.map((participantIdentity) => ({ participantIdentity, allowAll: true })),
    );
  }

  setPlayback(identity: string, enabled: boolean, volume: number) {
    this.play.set(identity, { enabled, volume });
    this.apply(identity);
  }

  private apply(identity: string) {
    const p = this.room.remoteParticipants.get(identity);
    const want = this.play.get(identity) ?? { enabled: false, volume: 0 };
    if (!p) return;
    for (const pub of p.audioTrackPublications.values()) {
      const t = pub.track as RemoteAudioTrack | undefined;
      // volume gating is instant (no renegotiation), so the first syllable is never clipped
      t?.setVolume(want.enabled ? want.volume : 0);
    }
  }

  remoteIdentities() {
    return [...this.room.remoteParticipants.keys()];
  }

  async startAudio() {
    void this.noiseCtx?.resume().catch(() => {});
    await this.room.startAudio();
    this.ev.playbackBlocked(!this.room.canPlaybackAudio);
  }
  async setInputDevice(id: string) {
    this.inputDeviceId = id;
    await this.room.switchActiveDevice("audioinput", id);
  }
  async setOutputDevice(id: string) {
    await this.room.switchActiveDevice("audiooutput", id);
  }

  /** Voice isolation on/off. Serialised so rapid taps can't interleave processor swaps. */
  setNoiseFilter(on: boolean) {
    this.noiseWanted = on;
    this.noiseBusy = this.noiseBusy.then(() => this.applyNoise()).catch(() => {});
    return this.noiseBusy;
  }

  private async applyNoise(): Promise<void> {
    const mic = this.mic;
    const on = this.noiseWanted;
    // no mic (still connecting, or capture failed — reported separately): just reflect the choice
    if (!mic) return this.ev.noiseState(on ? "on" : "off");
    const active = mic.getProcessor() instanceof VoiceIsolation;
    if (on === active) return this.ev.noiseState(on ? "on" : "off");
    if (!on) {
      await mic.stopProcessor();
      await this.browserSuppression(mic, true);
      return this.ev.noiseState("off");
    }
    if (!voiceIsolationSupported()) {
      await this.browserSuppression(mic, true);
      return this.ev.noiseState("basic", "This browser can't run voice isolation; using basic noise reduction.");
    }
    this.ev.noiseState("loading");
    try {
      this.noiseCtx ??= new AudioContext({ sampleRate: NOISE_SAMPLE_RATE, latencyHint: "interactive" });
      void this.noiseCtx.resume().catch(() => {});
      mic.setAudioContext(this.noiseCtx);
      // DeepFilterNet replaces the browser's suppressor; running both smears speech
      await this.browserSuppression(mic, false);
      await mic.setProcessor(new VoiceIsolation());
      if (!this.noiseWanted) return this.applyNoise(); // switched off while the model loaded
      this.ev.noiseState("on");
    } catch (e: any) {
      await mic.stopProcessor().catch(() => {});
      await this.browserSuppression(mic, true);
      this.ev.noiseState("basic", `Voice isolation failed (${e?.message ?? e}); using basic noise reduction.`);
    }
  }

  private async browserSuppression(mic: LocalAudioTrack, on: boolean) {
    try {
      await mic.mediaStreamTrack.applyConstraints({ echoCancellation: true, autoGainControl: true, noiseSuppression: on, channelCount: 1 });
    } catch {}
  }
  rttMs() {
    const rtt = (this.room as any).engine?.client?.rtt;
    return typeof rtt === "number" && rtt > 0 ? Math.round(rtt) : null;
  }
  async inboundPackets() {
    const out: Record<string, number> = {};
    for (const p of this.room.remoteParticipants.values()) {
      let n = 0;
      for (const pub of p.audioTrackPublications.values()) {
        const report = await pub.track?.getRTCStatsReport?.();
        report?.forEach((s: any) => {
          if (s.type === "inbound-rtp") n += s.packetsReceived ?? 0;
        });
      }
      out[p.identity] = n;
    }
    return out;
  }
}
