// Diagnostic: drive the real Google pop-up flow in headed Edge and report where it stops.
import { chromium } from "playwright-core";

const target = process.argv[2] || "https://grabb-xi.vercel.app/login";
const browser = await chromium.launch({ channel: "msedge", headless: false });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// SIMULATE_PROXY=1: pretend the server has FIREBASE_AUTH_PROXY=1 so the SDK uses this site as authDomain.
if (process.env.SIMULATE_PROXY === "1") {
  await page.route("**/firebase-config.json", async (route) => {
    const res = await route.fetch();
    const cfg = await res.json();
    await route.fulfill({ json: { ...cfg, authProxy: true } });
  });
}

page.on("console", (m) => { if (["error", "warning"].includes(m.type())) log("MAIN console", m.type(), m.text().slice(0, 200)); });
page.on("pageerror", (e) => log("MAIN pageerror", e.message.slice(0, 200)));
page.on("requestfailed", (r) => { if (!/CheckConnection|generate_204/.test(r.url())) log("MAIN reqfail", r.failure()?.errorText, r.url().slice(0, 120)); });

ctx.on("page", (popup) => {
  log("POPUP opened");
  popup.on("framenavigated", (f) => { if (f === popup.mainFrame()) log("POPUP nav", f.url().slice(0, 160)); });
  popup.on("console", (m) => log("POPUP console", m.type(), m.text().slice(0, 300)));
  popup.on("pageerror", (e) => log("POPUP pageerror", e.message.slice(0, 300)));
  popup.on("requestfailed", (r) => log("POPUP reqfail", r.failure()?.errorText, r.url().slice(0, 140)));
  popup.on("response", (r) => { if (r.status() >= 400) log("POPUP http", r.status(), r.url().slice(0, 140)); });
  popup.on("close", () => log("POPUP closed"));
  setTimeout(async () => {
    try {
      const txt = await popup.evaluate(() => document.body?.innerText?.slice(0, 600));
      log("POPUP body text after 12s:", JSON.stringify(txt));
    } catch (e) { log("POPUP read failed:", e.message.slice(0, 120)); }
  }, 12000);
});

await page.goto(target, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
log("MAIN", page.url());
await page.click("#google-btn");
await page.waitForTimeout(20000);
const err = await page.evaluate(() => ({ err: document.querySelector("#error")?.textContent, shown: document.querySelector("#error") && !document.querySelector("#error").hidden }));
log("MAIN error box:", JSON.stringify(err));
await browser.close();
