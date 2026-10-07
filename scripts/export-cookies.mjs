// Exports YouTube cookies from a Chromium browser (Brave/Chrome/Edge) into ./cookies.txt (Netscape format).
// Newer Chromium "app-bound" cookie encryption defeats yt-dlp's --cookies-from-browser on Windows, so instead we
// launch the browser with a DevTools port, let you sign in to YouTube in that window, and ask the browser for the
// decrypted cookies over CDP once a logged-in session appears.
//   node scripts/export-cookies.mjs [brave|chrome|edge]   (default: brave; close the browser first)
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const browser = process.argv[2] ?? "brave";
const home = process.env.USERPROFILE ?? process.env.HOME;
const local = process.env.LOCALAPPDATA ?? `${home}/AppData/Local`;
const pf = process.env.ProgramFiles ?? "C:/Program Files";
const pf86 = process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)";
const known = {
  brave: { exe: [`${pf}/BraveSoftware/Brave-Browser/Application/brave.exe`, `${local}/BraveSoftware/Brave-Browser/Application/brave.exe`], data: `${local}/BraveSoftware/Brave-Browser/User Data` },
  chrome: { exe: [`${pf}/Google/Chrome/Application/chrome.exe`, `${pf86}/Google/Chrome/Application/chrome.exe`, `${local}/Google/Chrome/Application/chrome.exe`], data: `${local}/Google/Chrome/User Data` },
  edge: { exe: [`${pf86}/Microsoft/Edge/Application/msedge.exe`, `${pf}/Microsoft/Edge/Application/msedge.exe`], data: `${local}/Microsoft/Edge/User Data` },
};
const cfg = known[browser];
if (!cfg) throw new Error(`Unknown browser "${browser}". Use brave, chrome or edge.`);
const exe = cfg.exe.find(existsSync);
if (!exe) throw new Error(`${browser} not found.`);

const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F&service=youtube";
const LOGIN_COOKIES = ["SID", "LOGIN_INFO", "__Secure-3PSID"];
const port = 9222 + Math.floor(Math.random() * 1000);
const proc = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${cfg.data}`, "--profile-directory=Default", "--no-first-run", LOGIN_URL], { stdio: "ignore" });

async function readCookies(ctx) {
  const all = await ctx.cookies(["https://www.youtube.com", "https://youtube.com", "https://accounts.google.com", "https://www.google.com"]);
  return all.filter((c) => /(^|\.)(youtube|google)\.com$/.test(c.domain.replace(/^\./, "")));
}

try {
  let cdp;
  for (let i = 0; i < 40 && !cdp; i++) {
    await new Promise((r) => setTimeout(r, 500));
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  if (!cdp) throw new Error(`Could not connect to ${browser} on port ${port}. Close every ${browser} window (and its tray icon) and run this again.`);
  const ctx = cdp.contexts()[0];

  console.log(`${browser} is open on the Google sign-in page. Sign in to YouTube there; waiting (up to 10 min)...`);
  let cookies = [];
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    cookies = await readCookies(ctx);
    if (cookies.some((c) => LOGIN_COOKIES.includes(c.name))) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const loggedIn = cookies.some((c) => LOGIN_COOKIES.includes(c.name));
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
  console.log(`Wrote cookies.txt: ${cookies.length} cookies for youtube.com/google.com; logged in: ${loggedIn ? "yes" : "NO — timed out waiting for sign-in"}`);
  process.exitCode = loggedIn ? 0 : 2;
} finally {
  proc.kill();
}
