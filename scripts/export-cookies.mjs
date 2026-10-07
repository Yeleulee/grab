// Exports YouTube cookies for the server into ./cookies.txt (Netscape format).
// Two things make this work where plain exports fail:
//   1. Chromium's app-bound cookie encryption defeats yt-dlp's --cookies-from-browser on Windows, so we launch the
//      browser with a DevTools port and ask it for the decrypted cookies over CDP.
//   2. YouTube rotates account cookies in any browser that stays signed in, which silently invalidates every
//      exported copy (yt-dlp: "cookies are no longer valid ... rotated in the browser"). So the sign-in happens in a
//      throwaway profile that is deleted right after the export — that session is never opened again, so never rotated.
//   node scripts/export-cookies.mjs [brave|chrome|edge]   (default: brave; your normal browser windows can stay open)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const browser = process.argv[2] ?? "brave";
const local = process.env.LOCALAPPDATA ?? `${process.env.USERPROFILE ?? process.env.HOME}/AppData/Local`;
const pf = process.env.ProgramFiles ?? "C:/Program Files";
const pf86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
const known = {
  brave: [`${pf}/BraveSoftware/Brave-Browser/Application/brave.exe`, `${local}/BraveSoftware/Brave-Browser/Application/brave.exe`],
  chrome: [`${pf}/Google/Chrome/Application/chrome.exe`, `${pf86}/Google/Chrome/Application/chrome.exe`, `${local}/Google/Chrome/Application/chrome.exe`],
  edge: [`${pf86}/Microsoft/Edge/Application/msedge.exe`, `${pf}/Microsoft/Edge/Application/msedge.exe`],
};
if (!known[browser]) throw new Error(`Unknown browser "${browser}". Use brave, chrome or edge.`);
const exe = known[browser].find(existsSync);
if (!exe) throw new Error(`${browser} not found.`);

const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F&service=youtube";
const LOGIN_COOKIES = ["SID", "LOGIN_INFO", "__Secure-3PSID"];
const port = 9222 + Math.floor(Math.random() * 1000);
const profile = mkdtempSync(path.join(tmpdir(), "grab-cookies-"));
const proc = spawn(
  exe,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", LOGIN_URL],
  { stdio: "ignore" },
);
let exited = false;
proc.once("exit", () => (exited = true));

const readCookies = async (ctx) => (await ctx.cookies(["https://www.youtube.com"])).filter((c) => /(^|\.)youtube\.com$/.test(c.domain));
const isLoggedIn = (cookies) => cookies.some((c) => LOGIN_COOKIES.includes(c.name));

try {
  let cdp;
  for (let i = 0; i < 40 && !cdp; i++) {
    await new Promise((r) => setTimeout(r, 500));
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  if (!cdp) throw new Error(`Could not connect to ${browser} on port ${port}.`);
  const ctx = cdp.contexts()[0];

  console.log(`${browser} opened a throwaway profile on Google's sign-in page. Sign in to YouTube there (a spare account is safer — Google may restrict accounts used this way); waiting (up to 10 min)...`);
  let cookies = [];
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && !isLoggedIn(cookies)) {
    await new Promise((r) => setTimeout(r, 3000));
    cookies = await readCookies(ctx);
  }
  const loggedIn = isLoggedIn(cookies);
  if (loggedIn) {
    await new Promise((r) => setTimeout(r, 5000)); // let YouTube finish setting its own cookies
    cookies = await readCookies(ctx);
  }
  await cdp.close();

  const lines = ["# Netscape HTTP Cookie File", "# Exported by scripts/export-cookies.mjs", ""];
  for (const c of cookies) {
    const domain = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
    const expires = c.expires && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push([domain, "TRUE", c.path || "/", c.secure ? "TRUE" : "FALSE", expires, c.name, c.value].join("\t"));
  }
  writeFileSync(new URL("../cookies.txt", import.meta.url), lines.join("\n") + "\n");
  console.log(`Wrote cookies.txt: ${cookies.length} youtube.com cookies; logged in: ${loggedIn ? "yes" : "NO — timed out waiting for sign-in"}`);
  if (loggedIn) console.log("Done — that profile is deleted, so this session can't be rotated; keep using the account normally elsewhere. Next: npm run render:cookies");
  process.exitCode = loggedIn ? 0 : 2;
} finally {
  // Kill the browser before deleting its profile; the session must never be reopened, or it gets rotated.
  if (!exited) {
    proc.kill();
    await new Promise((r) => proc.once("exit", r));
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
