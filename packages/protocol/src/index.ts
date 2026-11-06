// PartyLine Control Protocol v1 — types from docs/PROTOCOL.md §3.4 and the message
// tables in §2–§3. PROTOCOL.md is the source of truth; change it first.

export const API_VERSION = 1 as const;
export const ROOM_NAME = "partyline";

export type Platform = "ios" | "android" | "web" | "desktop";
export type TalkMode = "ptt" | "latch";
export type TargetRef = "all" | `g:${string}` | `d:${string}`;

export interface Group {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  defaultTalkMode: TalkMode | null;
}

export interface LiveState {
  online: boolean;
  rtcConnected: boolean;
  micLive: boolean;
  speakerMuted: boolean;
  talkMode: TalkMode;
  talkTargets: TargetRef[]; // never includes "all"; server expands it
  speaking: boolean;
  battery: number | null;
  charging: boolean | null;
  headset: boolean | null;
  outputRoute: string | null;
  rttMs: number | null;
}

export interface Device {
  id: string;
  displayName: string;
  platform: Platform;
  appVersion: string;
  groupId: string;
  listenGroupIds: string[];
  canTalkGroupIds: string[];
  isAdmin: boolean;
  forcedTalkMode: TalkMode | null;
  adminMuted: boolean;
  createdAt: string;
  lastSeenAt: string;
  live: LiveState;
}

export interface ServerInfo {
  serverId: string;
  name: string;
  appVersion: string;
  apiVersion: 1;
  joinCode: string | null; // null for non-admins
  joinOpen: boolean;
  fingerprint: string;
  failedJoinAttempts: number; // admins only, last hour
}

export interface Settings {
  crewCanBroadcast: boolean;
  defaultTalkMode: TalkMode;
  quickReplies: string[];
  adminsHearEverything?: boolean; // PROTOCOL §5.1, default false
  iosInstallUrl?: string | null; // https link (e.g. TestFlight) shown on the /#install page
}

export type MessageKind = "text" | "quick";

export interface Message {
  id: string;
  from: string;
  to: TargetRef;
  kind: MessageKind;
  text: string;
  ts: string;
  ackedBy?: string[];
}

// ---------- REST (§2) ----------

export type ErrorCode =
  | "invalid_code"
  | "join_closed"
  | "rate_limited"
  | "revoked"
  | "invalid_token"
  | "not_admin"
  | "not_found"
  | "bad_request"
  | "version_unsupported";

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export interface InfoResponse {
  apiVersion: 1;
  serverId: string;
  name: string;
  appVersion: string;
  fingerprint: string;
  joinOpen: boolean;
  livekitUrl: string;
  minClientVersion: string;
  /** Android app bundled with the host, or null (proposed change 5) */
  androidApk?: { url: string; size: number } | null;
  /** iPhone install link (TestFlight), or null */
  iosInstallUrl?: string | null;
}

export interface JoinRequest {
  joinCode: string;
  deviceId: string;
  displayName: string;
  platform: Platform;
  appVersion: string;
  apiVersion: number;
}

export interface SessionResponse {
  livekitToken: string;
  livekitUrl: string;
  roomName: string;
  me: Device;
  groups: Group[];
}

export interface JoinResponse extends SessionResponse {
  deviceToken: string;
}

export interface SessionRequest {
  appVersion: string;
  apiVersion: number;
}

// ---------- WebSocket (§3) ----------

export interface Envelope<T extends string = string, P = unknown> {
  type: T;
  id?: string;
  ts?: string;
  payload: P;
}

export interface StateSetPayload {
  talkTargets?: TargetRef[];
  listenGroupIds?: string[];
  micLive?: boolean;
  speakerMuted?: boolean;
  talkMode?: TalkMode;
}

export interface StatusPayload {
  rtcConnected: boolean;
  speaking: boolean;
  battery?: number;
  charging?: boolean;
  headset?: boolean;
  rttMs?: number;
  outputRoute?: "headset" | "speaker" | "earpiece" | "bluetooth";
}

export interface ClientPayloads {
  auth: { deviceToken: string; appVersion: string };
  ping: Record<string, never>;
  "state.set": StateSetPayload;
  status: StatusPayload;
  "message.send": { to: TargetRef; text: string; kind: MessageKind };
  "message.ack": { messageId: string };
  "signal.send": { to: TargetRef };
  "token.refresh": Record<string, never>;
  // admin only
  "admin.device.update": {
    deviceId: string;
    displayName?: string;
    groupId?: string;
    listenGroupIds?: string[];
    canTalkGroupIds?: string[];
    isAdmin?: boolean;
    forcedTalkMode?: TalkMode | null;
  };
  "admin.device.mute": { deviceId: string; muted: boolean };
  "admin.device.remove": { deviceId: string };
  "admin.device.forget": { deviceId: string };
  "admin.group.create": { name: string; color?: string; defaultTalkMode?: TalkMode | null };
  "admin.group.update": {
    groupId: string;
    name?: string;
    color?: string;
    sortOrder?: number;
    defaultTalkMode?: TalkMode | null;
  };
  "admin.group.delete": { groupId: string; moveDevicesTo: string };
  "admin.join.rotate": Record<string, never>;
  "admin.join.setOpen": { open: boolean };
  "admin.settings.update": {
    serverName?: string;
    crewCanBroadcast?: boolean;
    defaultTalkMode?: TalkMode;
    iosInstallUrl?: string | null; // https only; null/"" clears
  };
}

export interface WelcomePayload {
  me: Device;
  devices: Device[];
  groups: Group[];
  server: ServerInfo;
  settings: Settings;
  livekitToken: string;
  roomName: string;
  messages: Message[];
}

export type AdminNoticeKind = "muted" | "unmuted" | "moved" | "renamed" | "forcedPtt";

export interface ServerPayloads {
  welcome: WelcomePayload;
  ack: { replyTo: string };
  error: { replyTo?: string; code: ErrorCode | string; message: string };
  pong: Record<string, never>;
  "device.upsert": Device;
  "device.removed": { deviceId: string };
  "groups.updated": { groups: Group[] };
  "server.updated": ServerInfo;
  "settings.updated": Settings;
  message: Message;
  "message.acked": { messageId: string; deviceId: string; ts: string };
  signal: { from: string; to: TargetRef };
  "token.refreshed": { livekitToken: string };
  "admin.notice": { kind: AdminNoticeKind; text: string };
  kicked: { reason: "removed_by_admin" | string };
  "server.shutdown": { reconnectAfterMs: number };
}

export type ClientType = keyof ClientPayloads;
export type ServerType = keyof ServerPayloads;

export type ClientMessage = { [K in ClientType]: Envelope<K, ClientPayloads[K]> }[ClientType];
export type ServerMessage = { [K in ServerType]: Envelope<K, ServerPayloads[K]> }[ServerType];

export const ADMIN_TYPES: ReadonlyArray<ClientType> = [
  "admin.device.update",
  "admin.device.mute",
  "admin.device.remove",
  "admin.device.forget",
  "admin.group.create",
  "admin.group.update",
  "admin.group.delete",
  "admin.join.rotate",
  "admin.join.setOpen",
  "admin.settings.update",
];

/** LiveKit participant metadata set by the server on token issue (§5). */
export interface ParticipantMetadata {
  groupId: string;
  isAdmin: boolean;
}
