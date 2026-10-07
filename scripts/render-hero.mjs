// Renders the landing-page hero motion piece: scripts/hero-scene.html → frames → public/hero.mp4 + hero.webm + poster.
// The scene exposes window.seek(ms) and window.SCENE = { width, height, duration }; every frame is a pure function
// of time, so we can render sub-frames and blend them (ffmpeg tmix) for real motion blur.
//   node scripts/render-hero.mjs                 full render: 30 fps, 4 sub-frames per frame
//   node scripts/render-hero.mjs --preview       1 frame per 250 ms, no encode (look at .hero-frames/)
//   node scripts/render-hero.mjs --at 5350 7900  write single frames at those timestamps to .hero-frames/
//   node scripts/render-hero.mjs --og            screenshot scripts/og-card.html → public/og.jpg (1200×630)
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const FPS = 30, SUB = 4; // sub-frames blended per output frame
const FRAMES = path.join(ROOT, ".hero-frames");
const FFMPEG = path.join(ROOT, "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const browser = await chromium.launch({ channel: "msedge", headless: true });

if (argv.includes("--og")) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.join(__dirname, "og-card.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await page.screenshot({ path: path.join(ROOT, "public", "og.png") });
  spawnSync(FFMPEG, ["-y", "-v", "error", "-i", path.join(ROOT, "public", "og.png"), "-vf", "scale=1200:630", "-q:v", "2", path.join(ROOT, "public", "og.jpg")], { stdio: "inherit" });
  rmSync(path.join(ROOT, "public", "og.png"), { force: true });
  console.log("wrote public/og.jpg");
  await browser.close();
  process.exit(0);
}

const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(__dirname, "hero-scene.html")).href);
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
const SCENE = await page.evaluate(() => window.SCENE);
await page.setViewportSize({ width: SCENE.width, height: SCENE.height });

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
const shot = (t, file) => page.evaluate((t) => window.seek(t), t).then(() => page.screenshot({ path: path.join(FRAMES, file), animations: "disabled" }));

if (argv.includes("--at")) {
  for (const t of argv.slice(argv.indexOf("--at") + 1).map(Number).filter((n) => !Number.isNaN(n))) await shot(t, `at_${String(t).padStart(5, "0")}.png`);
  console.log(`frames → ${FRAMES}`);
  await browser.close();
  process.exit(0);
}

if (argv.includes("--preview")) {
  const step = 250;
  for (let t = 0, i = 0; t < SCENE.duration; t += step, i++) await shot(t, `p${String(i).padStart(4, "0")}_${String(t).padStart(5, "0")}.png`);
  console.log(`${Math.ceil(SCENE.duration / step)} preview frames → ${FRAMES}`);
  await browser.close();
  process.exit(0);
}

const total = Math.round((SCENE.duration / 1000) * FPS) * SUB;
const t0 = Date.now();
for (let i = 0; i < total; i++) {
  // sub-frame i sits inside output frame floor(i/SUB), spread across that frame's 1/FPS exposure window
  await shot((i / (FPS * SUB)) * 1000, `f${String(i).padStart(6, "0")}.png`);
  if (i % (FPS * SUB) === 0) process.stdout.write(`\r${i / SUB}/${total / SUB} frames`);
}
await browser.close();
console.log(`\r${total / SUB} frames (${total} sub-frames) rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// tmix averages SUB consecutive sub-frames; select keeps one blended result per output frame.
const blur = `tmix=frames=${SUB}:weights='${Array(SUB).fill(1).join(" ")}',select='not(mod(n\\,${SUB}))',setpts=N/${FPS}/TB`;
const input = ["-y", "-v", "error", "-framerate", String(FPS * SUB), "-i", path.join(FRAMES, "f%06d.png")];
const outputs = [
  { file: "hero.mp4", args: ["-vf", blur, "-r", String(FPS), "-c:v", "libx264", "-preset", "veryslow", "-crf", "15", "-profile:v", "high", "-pix_fmt", "yuv420p", "-movflags", "+faststart"] },
  { file: "hero.webm", args: ["-vf", blur, "-r", String(FPS), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "26", "-deadline", "good", "-cpu-used", "1", "-row-mt", "1", "-pix_fmt", "yuv420p"] },
];
for (const { file, args } of outputs) {
  const r = spawnSync(FFMPEG, [...input, ...args, "-an", path.join(ROOT, "public", file)], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) { console.error(r.stderr.toString().split("\n").slice(-15).join("\n")); process.exit(1); }
  console.log(`wrote public/${file}`);
}
// Poster: the title card fully on screen (also the reduced-motion fallback).
const posterT = 1900;
const posterIdx = Math.round((posterT / 1000) * FPS * SUB);
spawnSync(FFMPEG, ["-y", "-v", "error", "-i", path.join(FRAMES, `f${String(posterIdx).padStart(6, "0")}.png`), "-q:v", "2", path.join(ROOT, "public", "hero-poster.jpg")], { stdio: "inherit" });
console.log("wrote public/hero-poster.jpg");
rmSync(FRAMES, { recursive: true, force: true });
