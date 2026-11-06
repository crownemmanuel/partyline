// Headset / lock-screen button (Media Session) toggles the crew mic.
//   node headset.mjs <join code>   (host on https://192.168.86.40:9643, loopback admin on :9642)
import { chromium } from "playwright";
const CODE = process.argv[2];
const URL_ = process.env.URL ?? "https://192.168.86.40:9643", ADMIN = process.env.ADMIN_URL ?? "http://127.0.0.1:9642";
let fails = 0; const ok = (c, w) => { console.log(`${c ? "PASS" : "FAIL"}  ${w}`); if (!c) fails++; };
const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--ignore-certificate-errors","--autoplay-policy=no-user-gesture-required"] });
const P = await (await b.newContext({ permissions: ["microphone"] })).newPage();
await P.goto(ADMIN + "/");
await P.waitForFunction(() => window.partyline?.get().rtc === "connected");
const ctx = await b.newContext({ ignoreHTTPSErrors: true, permissions: ["microphone"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// capture what the page registers, so the test can "press" the headset button
await ctx.addInitScript(() => {
  window.__ms = {};
  const orig = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  navigator.mediaSession.setActionHandler = (a, h) => { window.__ms[a] = h; return orig(a, h); };
});
const C = await ctx.newPage();
await C.goto(URL_ + "/");
await C.getByPlaceholder("000000").fill(CODE);
await C.getByPlaceholder("Camera 2").fill("Headset cam");
await C.getByRole("button", { name: "Join" }).click();
await C.waitForFunction(() => window.partyline?.get().rtc === "connected");
await C.waitForTimeout(800);
const reg = await C.evaluate(() => Object.entries(window.__ms).filter(([, h]) => h).map(([a]) => a));
ok(["play", "pause", "togglemicrophone"].every((a) => reg.includes(a)), `handlers registered: ${reg.join(", ")}`);
const live = () => C.evaluate(() => { const s = window.partyline.get(); return s.devices[s.meId].live.micLive; });
const card = () => C.evaluate(() => ({ title: navigator.mediaSession.metadata?.title, artist: navigator.mediaSession.metadata?.artist, state: navigator.mediaSession.playbackState }));
ok(!(await live()) && (await card()).title?.startsWith("Muted"), `card before: ${JSON.stringify(await card())}`);
await C.evaluate(() => window.__ms.play());
await C.waitForTimeout(400);
ok(await live(), "headset press → mic live");
const id = await C.evaluate(() => window.partyline.get().meId);
ok(await P.evaluate((id) => window.partyline.get().devices[id].live.micLive, id), "producer sees the crew mic live");
ok((await card()).title?.startsWith("Mic LIVE") && (await card()).state === "playing", `card while live: ${JSON.stringify(await card())}`);
await C.evaluate(() => window.__ms.pause());
await C.waitForTimeout(400);
ok(!(await live()), "second press → muted");
await C.evaluate(() => window.__ms.togglemicrophone());
await C.waitForTimeout(400);
ok(await live(), "Chrome togglemicrophone action also toggles");
await C.evaluate(() => window.__ms.togglemicrophone());
// admin mute blocks it
await P.evaluate((id) => window.partyline.send("admin.device.mute", { deviceId: id, muted: true }), id);
await C.waitForTimeout(600);
await C.evaluate(() => window.__ms.play());
await C.waitForTimeout(400);
ok(!(await live()), "admin-muted: headset press can't unmute");
await P.evaluate((id) => window.partyline.send("admin.device.mute", { deviceId: id, muted: false }), id);
// setting off removes handlers
await C.getByRole("button", { name: "Settings" }).click();
await C.getByText("Headset button toggles mic").click();
await C.waitForTimeout(300);
const reg2 = await C.evaluate(() => Object.entries(window.__ms).filter(([, h]) => h).map(([a]) => a));
ok(reg2.length === 0, `setting off → handlers removed (${reg2.join(",") || "none"})`);
await b.close();
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
