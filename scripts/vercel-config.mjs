// Vercel build step: point the static frontend at the Render API.
// Runs only on Vercel (see vercel.json); locally config.js stays "" so the page talks to its own server.
import { writeFileSync } from "node:fs";

const api = (process.env.GRAB_API_URL || "https://grab-dkfd.onrender.com").replace(/\/$/, "");
writeFileSync(
  new URL("../public/config.js", import.meta.url),
  `// Generated at build time by scripts/vercel-config.mjs\nwindow.GRAB_API = ${JSON.stringify(api)};\n`,
);
console.log(`config.js -> GRAB_API = ${api}`);
