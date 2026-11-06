// Browser acceptance checks for DESKTOP.md items 2–5 (and 7 via API), with Chrome fake mics.
//   node acceptance.mjs --url=https://192.168.86.40:8443 --code=483920 [--admin-url=http://127.0.0.1:8442] [--mock]
// --mock: admin is promoted through the mock's /mock/promote endpoint instead of the host's loopback page.
import { chromium } from "playwright";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const URL_ = args.url;
const CODE = args.code;
const headless = args.headed !== "true";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

let fails = 0;
const ok = (c, what) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${what}`);
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: "chrome",
  headless,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors"],
});
async function client(name, { url = URL_, code = CODE, local = false } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ["microphone"] });
  // routing checks count packets; Chrome's fake mic is a steady beep that voice isolation removes
  // as noise (then DTX sends almost nothing), so keep it off here — noise.mjs tests the filter
  await ctx.addInitScript(() => localStorage.setItem("pl.prefs", JSON.stringify({ noiseFilter: false })));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.stack?.split("\n").slice(0, 4).join(" | ")));
  await page.goto(url);
  if (!local) {
    // the host's own loopback page joins by itself (localHost); crew fills the form
    await page.getByPlaceholder("000000").fill(code);
    await page.getByPlaceholder("Camera 2").fill(name);
    await page.getByRole("button", { name: "Join" }).click();
  }
  await page.waitForFunction(() => window.partyline?.get().rtc === "connected", null, { timeout: 15000 });
  const id = await page.evaluate(() => window.partyline.get().meId);
  return { name, ctx, page, id };
}
const st = (c) => c.page.evaluate(() => window.partyline.get());
const packets = (c) => c.page.evaluate(() => window.partyline.inboundPackets());
const send = (c, t, p) => c.page.evaluate(([t, p]) => window.partyline.send(t, p), [t, p]);

try {
  let P;
  if (args["admin-url"]) P = await client("Producer", { url: args["admin-url"], local: true });
  else {
    P = await client("Producer");
    await fetch(`${URL_}/mock/promote/${P.id}`, { method: "POST", body: "{}" });
    await P.page.reload();
    await P.page.waitForFunction(() => window.partyline?.get().rtc === "connected", null, { timeout: 15000 });
  }
  ok((await st(P)).devices[P.id].isAdmin, "producer is admin");
  await P.page.getByText("Talk & listen").waitFor();
  ok(true, "admin view shown");

  const C1 = await client("Camera 1");
  const C2 = await client("Camera 2");
  const B1 = await client("Backstage 1");
  const groups = (await st(P)).groups;
  const camera = groups.find((g) => g.id === "camera")?.id ?? groups[1].id;
  const backstage = groups.find((g) => g.id === "backstage")?.id ?? groups[2].id;
  for (const c of [C1, C2]) await send(P, "admin.device.update", { deviceId: c.id, groupId: camera });
  await send(P, "admin.device.update", { deviceId: B1.id, groupId: backstage });
  // producer listens to every group by default; talks to Camera
  await sleep(800);
  ok((await st(B1)).devices[B1.id].groupId === backstage, "B1 moved to Backstage (crew sees own group)");
  await B1.page.getByText(/backstage/i).first().waitFor();

  // --- C1 talks to Camera (hold the button with the mouse)
  const before = { C2: await packets(C2), B1: await packets(B1), P: await packets(P) };
  const btn = C1.page.getByRole("button", { name: "HOLD TO TALK" });
  const box = await btn.boundingBox();
  await C1.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await C1.page.mouse.down();
  await sleep(2500);
  const during = { C2: await packets(C2), B1: await packets(B1), P: await packets(P) };
  ok(((await st(P)).devices[C1.id].live.micLive), "admin roster shows C1 mic live");
  await C1.page.mouse.up();
  const d = (k) => (during[k][C1.id] ?? 0) - (before[k][C1.id] ?? 0);
  ok(d("C2") > 50, `C2 receives C1 audio (${d("C2")} packets)`);
  ok(d("P") > 50, `Producer (listening to Camera) receives C1 (${d("P")} packets)`);
  ok((during.B1[C1.id] ?? 0) === 0, `Backstage receives NO Camera audio (${during.B1[C1.id] ?? 0} packets total)`);

  // --- Producer talks to Camera only
  const b2 = { C1: await packets(C1), B1: await packets(B1) };
  await P.page.evaluate((cam) => window.partyline.setTalkTargets([`g:${cam}`], true), camera);
  await sleep(2500);
  const d2 = { C1: await packets(C1), B1: await packets(B1) };
  await P.page.evaluate(() => window.partyline.setMicLive(false));
  ok((d2.C1[P.id] ?? 0) - (b2.C1[P.id] ?? 0) > 50, `C1 hears producer talking to Camera (${(d2.C1[P.id] ?? 0) - (b2.C1[P.id] ?? 0)})`);
  ok((d2.B1[P.id] ?? 0) === 0, `Backstage gets no producer audio when producer talks to Camera (${d2.B1[P.id] ?? 0})`);

  // --- Producer talks to one device (C2 only)
  const b3 = { C1: await packets(C1), C2: await packets(C2) };
  await P.page.evaluate((id) => window.partyline.setTalkTargets([`d:${id}`], true), C2.id);
  await sleep(2500);
  const d3 = { C1: await packets(C1), C2: await packets(C2) };
  await P.page.evaluate(() => window.partyline.setMicLive(false));
  const c1gain = (d3.C1[P.id] ?? 0) - (b3.C1[P.id] ?? 0), c2gain = (d3.C2[P.id] ?? 0) - (b3.C2[P.id] ?? 0);
  ok(c2gain > 50 && c1gain < 5, `talk to one device: C2 +${c2gain}, C1 +${c1gain}`);

  // --- Admin mute C1 while C1 is talking (latch it via API to keep it live)
  await C1.page.evaluate(() => window.partyline.setMicLive(true));
  await sleep(1000);
  const t0 = Date.now();
  await P.page.evaluate((id) => window.partyline.send("admin.device.mute", { deviceId: id, muted: true }), C1.id);
  await C1.page.getByText("MUTED BY PRODUCER").first().waitFor({ timeout: 2000 });
  const lockMs = Date.now() - t0;
  ok(lockMs < 500, `C1 shows lock ${lockMs} ms after admin mute`);
  await sleep(1500);
  const m1 = await packets(C2);
  await sleep(1500);
  const m2 = await packets(C2);
  ok((m2[C1.id] ?? 0) - (m1[C1.id] ?? 0) < 5, `no audio from muted C1 (+${(m2[C1.id] ?? 0) - (m1[C1.id] ?? 0)} packets in 1.5 s)`);
  // try to unmute from the client: must stay muted
  await C1.page.evaluate(() => window.partyline.setMicLive(true));
  await sleep(1000);
  const m3 = await packets(C2);
  ok((m3[C1.id] ?? 0) - (m2[C1.id] ?? 0) < 5 && !(await st(P)).devices[C1.id].live.micLive, "muted client cannot unmute itself");
  await send(P, "admin.device.mute", { deviceId: C1.id, muted: false });

  // --- Messages + ack
  const TEXT = `Cam 2 tighter please ${Date.now() % 100000}`;
  await send(P, "message.send", { to: `g:${camera}`, text: TEXT, kind: "text" });
  const pop = C2.page.getByRole("alertdialog", { name: "New message" });
  await pop.getByText(TEXT).waitFor({ timeout: 2000 });
  ok(true, "crew gets the message as a pop-up straight away");
  ok(!(await st(P)).messages.at(-1)?.ackedBy?.includes(C2.id), "no read receipt before the pop-up is answered");
  await pop.getByRole("button", { name: "Reply" }).click();
  const panel = C2.page.getByRole("dialog", { name: "Messages" });
  await panel.waitFor({ timeout: 2000 });
  ok((await panel.locator("select").inputValue()) === `d:${P.id}`, "Reply opens the panel addressed to the sender");
  const REPLY = `On it ${Date.now() % 100000}`;
  await panel.getByPlaceholder("Message").fill(REPLY);
  await panel.getByRole("button", { name: "Send" }).click();
  await sleep(500);
  const msgs = (await st(P)).messages;
  ok(msgs.find((m) => m.text === TEXT)?.ackedBy?.includes(C2.id), "admin sees read receipt");
  const ppop = P.page.getByRole("alertdialog", { name: "New message" });
  await ppop.getByText(REPLY).waitFor({ timeout: 2000 });
  ok(true, "producer gets the reply as a pop-up");
  await ppop.getByRole("button", { name: "Close" }).click();
  ok((await ppop.count()) === 0 && (await st(P)).unread === 0, "Close dismisses it and clears the badge");
  await panel.getByRole("button", { name: "Close" }).click();
  ok((await panel.count()) === 0, "panel closes in place");
  ok(!(await st(B1)).messages.some((m) => m.text === TEXT), "Backstage did not get the Camera message");

  // --- Remove B1
  const tok = await B1.page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("pl.servers")))[0].token);
  await send(P, "admin.device.remove", { deviceId: B1.id });
  await B1.page.getByText(/removed by the producer/i).first().waitFor({ timeout: 3000 });
  ok(true, "removed browser bounced to Join screen");
  const r = await fetch(`${URL_}/api/session`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: "{}" });
  ok(r.status === 403, `old token -> ${r.status}`);

  if (args.keep === "true") {
    console.log("keeping browsers open; ctrl-c to exit");
    await new Promise(() => {});
  }
} catch (e) {
  console.log("FAIL  exception:", e.message.split("\n")[0]);
  fails++;
}
await browser.close();
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
