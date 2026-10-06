// Vercel build step (see vercel.json). Runs only on Vercel; locally the server serves everything itself.
//  1. Point the static frontend at the Render API (config.js).
//  2. Bundle the Firebase SDK into public/vendor/firebase so the import map resolves locally on Vercel's CDN
//     instead of proxying to Render (which sleeps on the free plan). The rewrite in vercel.json stays as a fallback.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const api = (process.env.GRAB_API_URL || "https://grab-dkfd.onrender.com").replace(/\/$/, "");
writeFileSync(
  new URL("../public/config.js", import.meta.url),
  `// Generated at build time by scripts/vercel-config.mjs\nwindow.GRAB_API = ${JSON.stringify(api)};\n`,
);
console.log(`config.js -> GRAB_API = ${api}`);

// Keep in sync with the import map in public/app.html and public/login.html.
const FIREBASE_VERSION = (readFileSync(new URL("../public/app.html", import.meta.url), "utf8").match(/firebasejs\/([\d.]+)\//) ?? [])[1] ?? "12.19.0";
const vendorDir = new URL("../public/vendor/firebase/", import.meta.url);
mkdirSync(vendorDir, { recursive: true });
for (const file of ["firebase-app.js", "firebase-auth.js"]) {
  const url = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/${file}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(new URL(file, vendorDir), Buffer.from(await res.arrayBuffer()));
    console.log(`vendor/firebase/${file} <- ${url}`);
  } catch (e) {
    console.warn(`Could not fetch ${url} (${e.message}); Vercel will proxy it from the API instead.`);
  }
}
