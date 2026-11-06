// Voice isolation check: a crew browser whose fake mic plays a noise file talks to the producer;
// the producer measures received audio energy with the filter on vs off.
//   node noise.mjs --url=https://192.168.86.40:9643 --code=040381 --admin-url=http://127.0.0.1:9642 --wav=/path/noise.wav
import { chromium } from "playwright";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, what) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${what}`);
  if (!c) fails++;
};
const base = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--ignore-certificate-errors"];
const rxBrowser = await chromium.launch({ channel: "chrome", headless: true, args: base });
const txBrowser = await chromium.launch({ channel: "chrome", headless: true, args: [...base, `--use-file-for-fake-audio-capture=${args.wav}`] });

async function client(browser, name, { url, code, local }) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ["microphone"] });
  // keep every RTCPeerConnection so the test can read inbound audio energy from getStats
  await ctx.addInitScript(() => {
    const PC = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) {
      const pc = new PC(...a);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = PC.prototype;
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.message));
  page.on("console", (m) => m.type() === "error" && console.log(`[${name}] console`, m.text().slice(0, 200)));
  await page.goto(url);
  if (!local) {
    // the host's own loopback page joins by itself (localHost); crew fills the form
    await page.getByPlaceholder("000000").fill(code);
    await page.getByPlaceholder("Camera 2").fill(name);
    await page.getByRole("button", { name: "Join" }).click();
  }
  await page.waitForFunction(() => window.partyline?.get().rtc === "connected", null, { timeout: 20000 });
  return { page, id: await page.evaluate(() => window.partyline.get().meId) };
}
const st = (c) => c.page.evaluate(() => window.partyline.get());
/** total inbound audio energy across all receivers */
const energy = (c) =>
  c.page.evaluate(async () => {
    let e = 0;
    for (const pc of window.__pcs) for (const r of (await pc.getStats()).values()) if (r.type === "inbound-rtp" && r.kind === "audio") e += r.totalAudioEnergy ?? 0;
    return e;
  });
async function measure(P, secs = 4) {
  const a = await energy(P);
  await sleep(secs * 1000);
  return ((await energy(P)) - a) / secs; // mean power, arbitrary units
}

try {
  const P = await client(rxBrowser, "Producer", { url: args["admin-url"], local: true });
  const C = await client(txBrowser, "Noisy cam", { url: args.url, code: args.code });

  const t0 = Date.now();
  await C.page.waitForFunction(() => ["on", "basic"].includes(window.partyline.get().noise), null, { timeout: 60000 });
  const s = await st(C);
  ok(s.noise === "on", `crew filter state "${s.noise}" after ${((Date.now() - t0) / 1000).toFixed(1)} s (default on)`);
  ok(await C.page.getByRole("switch", { name: /Voice isolation ON/ }).isVisible(), "crew screen shows the Voice isolation ON button");
  await P.page.waitForFunction(() => window.partyline.get().noise === "on", null, { timeout: 60000 });
  ok(true, "producer filter on too");

  await C.page.evaluate(() => window.partyline.setMicLive(true));
  await sleep(2500);
  const on = await measure(P);
  await C.page.getByRole("switch").click(); // the real button
  await C.page.waitForFunction(() => window.partyline.get().noise === "off", null, { timeout: 10000 });
  ok(true, "tapping the button turns it off");
  await sleep(2000);
  const off = await measure(P);
  console.log(`received noise power: filter ON ${on.toExponential(2)}, OFF ${off.toExponential(2)}`);
  ok(off > 0, "with the filter off the noise reaches the producer");
  ok(on < off / 10, `filter removes ≥90% of the noise power (ratio ${(on / off).toFixed(4)})`);

  await C.page.getByRole("switch").click();
  await C.page.waitForFunction(() => window.partyline.get().noise === "on", null, { timeout: 30000 });
  ok(true, "tapping again turns it back on (model already cached)");
  ok((await st(P)).devices[C.id].live.micLive, "mic still live after toggling");
} catch (e) {
  console.log("FAIL ", e.message);
  fails++;
} finally {
  if (args.keep !== "true") await Promise.all([rxBrowser.close(), txBrowser.close()]);
}
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
