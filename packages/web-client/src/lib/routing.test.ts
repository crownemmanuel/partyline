// node --experimental-strip-types --test src/lib/routing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedListeners, playback, routedToMe, producerTarget } from "./routing.ts";

const dev = (id: string, group: string, extra: any = {}): any => ({
  id, displayName: id, platform: "web", appVersion: "0", groupId: group, listenGroupIds: [group], canTalkGroupIds: [group],
  isAdmin: false, forcedTalkMode: null, adminMuted: false, createdAt: "", lastSeenAt: "",
  ...extra, live: { online: true, rtcConnected: true, micLive: false, speakerMuted: false, talkMode: "ptt", talkTargets: [`g:${group}`], speaking: false, battery: null, charging: null, headset: null, outputRoute: null, rttMs: null, ...(extra.live ?? {}) },
});
const P = dev("P", "producer", { isAdmin: true, listenGroupIds: ["producer", "camera"], live: { talkTargets: ["g:camera"] } });
const C1 = dev("C1", "camera"), C2 = dev("C2", "camera"), B1 = dev("B1", "backstage");
const roster = [P, C1, C2, B1];
const mix = { speakerMuted: false, localMute: {}, localVolume: {}, solo: [], groupVolume: {} };

test("producer to camera: C1, C2 only", () => assert.deepEqual(allowedListeners(P, roster), ["C1", "C2"]));
test("producer to camera+backstage", () => assert.deepEqual(allowedListeners({ ...P, live: { ...P.live, talkTargets: ["g:camera", "g:backstage"] } }, roster), ["B1", "C1", "C2"]));
test("producer to one device", () => assert.deepEqual(allowedListeners({ ...P, live: { ...P.live, talkTargets: ["d:C2"] } }, roster), ["C2"]));
test("camera talk reaches C2 and P (listens camera), not B1", () => assert.deepEqual(allowedListeners(C1, roster), ["C2", "P"]));
test("reply to producer: only P", () => assert.deepEqual(allowedListeners({ ...C1, live: { ...C1.live, talkTargets: ["d:P"] } }, roster), ["P"]));
test("backstage does not hear camera", () => assert.equal(routedToMe(B1, C1), false));
test("admin-muted speaker not played", () => assert.equal(playback(C2, { ...C1, adminMuted: true }, mix).enabled, false));
test("solo", () => {
  assert.equal(playback(P, C1, { ...mix, solo: ["C2"] }).enabled, false);
  assert.equal(playback(P, C2, { ...mix, solo: ["C2"] }).enabled, true);
});
test("speaker mute", () => assert.equal(playback(C2, C1, { ...mix, speakerMuted: true }).enabled, false));
test("producer target", () => assert.equal(producerTarget(C1, roster), "d:P"));
