// PROTOCOL.md §5.1 — the routing rule, identical on every client. Pure functions only.
import type { Device, Settings, TargetRef } from "@partyline/protocol";

/** Publisher side: identities allowed to receive my audio (LiveKit subscription permissions). */
export function allowedListeners(me: Device, roster: Iterable<Device>, settings?: Pick<Settings, "adminsHearEverything">): string[] {
  const targets = new Set<string>(me.live.talkTargets);
  const allowed: string[] = [];
  for (const d of roster) {
    if (d.id === me.id) continue;
    if (
      d.listenGroupIds.some((g) => targets.has(`g:${g}`)) ||
      targets.has(`d:${d.id}`) ||
      (d.isAdmin && targets.size > 0 && settings?.adminsHearEverything === true)
    ) {
      allowed.push(d.id);
    }
  }
  return allowed.sort();
}

/** Receiver side: does `speaker`'s routing say I should hear them (before local mutes)? */
export function routedToMe(me: Device, speaker: Device | undefined): boolean {
  if (!speaker || speaker.adminMuted) return false;
  const t = speaker.live.talkTargets;
  return t.includes(`d:${me.id}` as TargetRef) || me.listenGroupIds.some((g) => t.includes(`g:${g}` as TargetRef));
}

export interface LocalMix {
  speakerMuted: boolean;
  localMute: Record<string, boolean>;
  localVolume: Record<string, number>;
  /** when non-empty, only these device ids are played ("solo") */
  solo: string[];
  /** per-group listen volume (admin); applied to a speaker's loudest matching group */
  groupVolume: Record<string, number>;
}

/** Final playback decision for one remote participant. */
export function playback(me: Device, speaker: Device | undefined, mix: LocalMix): { enabled: boolean; volume: number } {
  const routed = routedToMe(me, speaker);
  if (!speaker || !routed || mix.speakerMuted || mix.localMute[speaker.id]) return { enabled: false, volume: 0 };
  if (mix.solo.length > 0 && !mix.solo.includes(speaker.id)) return { enabled: false, volume: 0 };
  let gv = 0;
  let direct = speaker.live.talkTargets.includes(`d:${me.id}` as TargetRef);
  for (const g of me.listenGroupIds) if (speaker.live.talkTargets.includes(`g:${g}` as TargetRef)) gv = Math.max(gv, mix.groupVolume[g] ?? 1);
  if (direct) gv = Math.max(gv, 1);
  const volume = (mix.localVolume[speaker.id] ?? 1) * gv;
  return { enabled: volume > 0, volume: Math.min(1, volume) };
}

/** PROTOCOL §6.4: reply-to-producer target = first online admin other than me. */
export function producerTarget(me: Device, roster: Iterable<Device>): TargetRef | null {
  const admins = [...roster].filter((d) => d.isAdmin && d.id !== me.id);
  const online = admins.find((d) => d.live.online) ?? admins[0];
  return online ? `d:${online.id}` : null;
}

/** Groups a device may talk to (PROTOCOL §4). */
export function talkableGroups(me: Device, allGroupIds: string[]): string[] {
  return me.isAdmin ? allGroupIds : me.canTalkGroupIds.filter((g) => allGroupIds.includes(g));
}

/** Groups a device may listen to (PROTOCOL §4). */
export function listenableGroups(me: Device, allGroupIds: string[]): string[] {
  return me.isAdmin ? allGroupIds : [...new Set([me.groupId, ...me.canTalkGroupIds])].filter((g) => allGroupIds.includes(g));
}
