// Renders the landing-page hero video: scripts/hero-scene.html → PNG frames → public/hero.mp4 + public/hero.webm.
// The scene exposes window.seek(ms) so every frame is deterministic; we step it at FPS and screenshot each one.
//   node scripts/render-hero.mjs            full render (~15 s of video)
//   node scripts/render-hero.mjs --preview  6 fps, writes frames only (quick look while iterating)
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const preview = process.argv.includes("--preview");
const FPS = preview ? 6 : 30;
const WIDTH = 1200;
const SCALE = 2; // retina-sharp text when the video is scaled down in the hero
const FRAMES = path.join(ROOT, ".hero-frames");
const FFMPEG = path.join(ROOT, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: 700 }, deviceScaleFactor: SCALE });
await page.goto(pathToFileURL(path.join(__dirname, "hero-scene.html")).href);
await page.evaluate(() => document.fonts.ready);
// The thumbnail lives inside a hidden block; decode it up front so the first result frame isn't blank.
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));

// Fix the viewport height to the tallest state (download in progress) so the frame size never changes.
const T = await page.evaluate(() => window.T);
const height = await page.evaluate((t) => window.seek(t), T.clickDl + 500);
await page.setViewportSize({ width: WIDTH, height });

const total = Math.ceil((T.end / 1000) * FPS);
const t0 = Date.now();
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.seek(t), (i / FPS) * 1000);
  await page.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(5, "0")}.png`), clip: { x: 0, y: 0, width: WIDTH, height } });
  if (i % FPS === 0) process.stdout.write(`\r${i}/${total} frames`);
}
await browser.close();
console.log(`\r${total} frames rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${FRAMES}`);
if (preview) process.exit(0);

const input = ["-y", "-framerate", String(FPS), "-i", path.join(FRAMES, "f%05d.png")];
// Even dimensions are required by yuv420p; the scale filter guarantees it.
const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
const outputs = [
  { file: "hero.mp4", args: ["-c:v", "libx264", "-preset", "veryslow", "-crf", "14", "-tune", "animation", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-vf", even] },
  { file: "hero.webm", args: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "24", "-deadline", "good", "-cpu-used", "1", "-row-mt", "1", "-pix_fmt", "yuv420p", "-vf", even] },
];
for (const { file, args } of outputs) {
  const out = path.join(ROOT, "public", file);
  const r = spawnSync(FFMPEG, [...input, ...args, "-an", out], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) { console.error(r.stderr.toString().split("\n").slice(-15).join("\n")); process.exit(1); }
  console.log(`wrote public/${file}`);
}
// Poster = the finished state, shown before the video starts and as the no-JS/reduced-motion fallback. Kept at 2x.
const posterFrame = readdirSync(FRAMES).sort().at(-1);
spawnSync(FFMPEG, ["-y", "-i", path.join(FRAMES, posterFrame), "-q:v", "2", path.join(ROOT, "public", "hero-poster.jpg")], { stdio: "ignore" });
console.log("wrote public/hero-poster.jpg");
rmSync(FRAMES, { recursive: true, force: true });
