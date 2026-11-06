// Acceptance 6: a browser stays joined while the host is quit and relaunched.
//   node restart.mjs --url=https://<ip>:<port> --code=<code> --restart="<shell cmd that restarts the host>"
import { chromium } from "playwright";
import { execSync } from "node:child_process";
const a = Object.fromEntries(process.argv.slice(2).map((x) => x.replace(/^--/, "").split(/=(.*)/s)).map(([k, v]) => [k, v]));
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--ignore-certificate-errors"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ["microphone"] });
const page = await ctx.newPage();
await page.goto(a.url);
await page.getByPlaceholder("000000").fill(a.code);
await page.getByPlaceholder("Camera 2").fill("Restart test");
await page.getByRole("button", { name: "Join" }).click();
await page.waitForFunction(() => window.partyline?.get().rtc === "connected", null, { timeout: 15000 });
const before = await page.evaluate(() => { const s = window.partyline.get(); return { group: s.devices[s.meId].groupId, id: s.meId }; });
console.log("joined", before);
const t0 = Date.now();
execSync(a.restart, { stdio: "inherit", shell: "/bin/zsh" });
await page.waitForFunction(() => window.partyline.get().ws !== "open", null, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => { const s = window.partyline.get(); return s.ws === "open" && s.rtc === "connected"; }, null, { timeout: 60000 });
const after = await page.evaluate(() => { const s = window.partyline.get(); return { group: s.devices[s.meId].groupId, id: s.meId, phase: s.phase }; });
const ok = after.id === before.id && after.group === before.group && after.phase === "live";
console.log(`${ok ? "PASS" : "FAIL"}  reconnected by itself ${((Date.now() - t0) / 1000).toFixed(1)} s after restart began`, after);
await browser.close();
process.exit(ok ? 0 : 1);
