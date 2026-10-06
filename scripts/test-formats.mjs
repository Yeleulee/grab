// Format matrix test: downloads every quality + MP3 + M4A through the API and
// verifies the output with ffprobe. Usage: node scripts/test-formats.mjs [videoUrl]
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FFPROBE = path.join(ROOT, "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
const API = process.env.API ?? "http://127.0.0.1:3000";
const URL_ = process.argv[2] ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

const api = async (p, opts) => {
  const r = await fetch(API + p, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.status);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probe(file) {
  const out = execFileSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,height", "-show_entries", "format=bit_rate", "-of", "json", file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return { vcodec: v?.codec_name, height: v?.height, acodec: a?.codec_name, kbps: Math.round((j.format?.bit_rate ?? 0) / 1000) };
}

const info = await api("/api/info", { method: "POST", body: JSON.stringify({ url: URL_ }) });
console.log(`\n${info.title}\n`);
const only = process.env.ONLY?.split(",").map((s) => s.trim().toLowerCase());
const codec = process.env.CODEC === "h264" ? "h264" : "best";
const cases = [
  ...info.qualities.map((q) => ({ kind: "video", height: q.height, label: q.label, codec: (codec === "h264" && q.h264 ? q.h264 : q.best).codec })),
  { kind: "mp3", label: "MP3" },
  { kind: "m4a", label: "M4A" },
].filter((c) => !only || only.includes(c.label.toLowerCase()) || only.includes(String(c.height)));

let failed = 0;
for (const c of cases) {
  const t0 = Date.now();
  const job = await api("/api/download", { method: "POST", body: JSON.stringify({ url: URL_, kind: c.kind, height: c.height, codec, title: info.title, thumbnail: info.thumbnail }) });
  let j = job, maxPct = 0, sawParts = false;
  while (j.status === "running") {
    await sleep(1000);
    j = (await api("/api/jobs")).find((x) => x.id === job.id);
    maxPct = Math.max(maxPct, j.progress?.percent ?? 0);
    if (j.progress?.parts > 1) sawParts = true;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (j.status !== "done" || !j.fileExists) {
    failed++;
    console.log(`  FAIL  ${c.label.padEnd(8)} ${j.status}: ${j.error ?? "no file"}`);
    continue;
  }
  const p = probe(j.filePath);
  let ok = !!p.acodec;
  if (c.kind === "video") ok &&= p.height === c.height && !!p.vcodec;
  if (c.kind === "mp3") ok &&= p.acodec === "mp3";
  if (c.kind === "m4a") ok &&= p.acodec === "aac";
  if (!ok) failed++;
  const mb = (j.fileSize / 1048576).toFixed(1).padStart(7);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${c.label.padEnd(8)} ${mb} MB  ${secs.padStart(3)}s  ${p.vcodec ?? "-"}${p.height ? " " + p.height + "p" : ""} / ${p.acodec}  ${p.kbps} kbps${sawParts ? "  (2-part progress ok)" : ""}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed\n`);
process.exit(failed ? 1 : 0);
