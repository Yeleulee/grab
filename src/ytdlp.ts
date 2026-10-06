import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BIN_DIR = path.resolve(__dirname, "..", "bin");
const EXE = process.platform === "win32" ? ".exe" : "";
export const YTDLP_PATH = path.join(BIN_DIR, `yt-dlp${EXE}`);
export const FFMPEG_PATH = path.join(BIN_DIR, `ffmpeg${EXE}`);

export function checkBinaries() {
  return {
    ytdlp: existsSync(YTDLP_PATH),
    ffmpeg: existsSync(FFMPEG_PATH),
  };
}

// yt-dlp is Python; without this its stdout on Windows is not UTF-8 and non-ASCII titles get mangled.
const YTDLP_ENV = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/** Validates and normalizes a YouTube URL. Returns null when the URL is not acceptable. */
export function normalizeYouTubeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  if (!YT_HOSTS.has(u.hostname)) return null;

  // Strip tracking params that don't affect the target video.
  for (const p of ["si", "feature", "pp", "ab_channel", "t"]) u.searchParams.delete(p);

  if (u.hostname.endsWith("youtu.be")) {
    const id = u.pathname.slice(1).split("/")[0];
    if (!id) return null;
    return `https://www.youtube.com/watch?v=${id}`;
  }
  const shorts = u.pathname.match(/^\/shorts\/([\w-]+)/);
  if (shorts) return `https://www.youtube.com/watch?v=${shorts[1]}`;

  return u.toString();
}

export interface VideoFormat {
  format_id: string;
  ext: string;
  height?: number | null;
  width?: number | null;
  fps?: number | null;
  vcodec?: string;
  acodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
  abr?: number | null;
  format_note?: string;
  protocol?: string;
}

export type CodecPref = "best" | "h264";

export interface QualityOption {
  codec: string;
  formatId: string;
  sizeEstimate: number | null;
  tbr: number | null;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
  view_count?: number;
  upload_date?: string;
  webpage_url: string;
  qualities: { height: number; label: string; fps: number | null; best: QualityOption; h264: QualityOption | null }[];
  audio: { label: string; kind: "mp3" | "m4a"; sizeEstimate: number | null; abr: number | null; note: string; formatId: string | null }[];
}

export const codecName = (v?: string) =>
  !v ? "" : v.startsWith("avc1") ? "H.264" : v.startsWith("av01") ? "AV1" : v.startsWith("vp09") || v === "vp9" ? "VP9" : v.split(".")[0];

/**
 * Rough perceptual efficiency relative to H.264 at the same bitrate. YouTube's VP9/AV1 encodes
 * often carry *more* bitrate than its H.264 ones too, so H.264 is frequently the worst-looking pick.
 */
const CODEC_WEIGHT: Record<string, number> = { "H.264": 1, VP9: 1.35, AV1: 1.6 };

const isUsableVideo = (f: VideoFormat) =>
  !!f.height && !!f.vcodec && f.vcodec !== "none" && !f.protocol?.includes("m3u8") && !!(f.tbr || f.filesize || f.filesize_approx);

/** Perceived-quality score for ranking streams at the same resolution. */
function qualityScore(f: VideoFormat): number {
  const w = CODEC_WEIGHT[codecName(f.vcodec)] ?? 0.9;
  return (f.tbr ?? 0) * w + (f.fps ?? 30) / 1000;
}

export function pickVideoFormat(formats: VideoFormat[], height: number, pref: CodecPref): VideoFormat | null {
  let pool = formats.filter((f) => isUsableVideo(f) && f.height === height);
  if (pref === "h264") {
    const h264 = pool.filter((f) => f.vcodec!.startsWith("avc1"));
    if (h264.length) pool = h264; // no H.264 above 1080p on YouTube â†’ fall through to best
  }
  return pool.sort((a, b) => qualityScore(b) - qualityScore(a))[0] ?? null;
}

export function pickAudioFormat(formats: VideoFormat[]): VideoFormat | null {
  const audio = formats.filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none" && !f.protocol?.includes("m3u8"));
  // AAC (m4a) muxes cleanly into MP4; Opus does not.
  const m4a = audio.filter((f) => f.ext === "m4a" || f.acodec?.startsWith("mp4a"));
  return (m4a.length ? m4a : audio).sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0] ?? null;
}

// Raw format lists are cached briefly so a download can reuse the metadata the UI just fetched.
const formatCache = new Map<string, { at: number; formats: VideoFormat[]; duration: number }>();
const FORMAT_TTL = 10 * 60_000;

async function fetchRaw(url: string) {
  const args = ["--encoding", "utf-8", "-J", "--no-playlist", "--no-warnings"];
  if (process.env.YTDLP_COOKIES_FILE) args.push("--cookies", process.env.YTDLP_COOKIES_FILE);
  const json = await run([...args, url]);
  const raw = JSON.parse(json);
  formatCache.set(raw.id, { at: Date.now(), formats: raw.formats ?? [], duration: raw.duration ?? 0 });
  return raw;
}

async function getFormats(url: string): Promise<{ formats: VideoFormat[]; duration: number }> {
  const id = new URL(url).searchParams.get("v");
  const hit = id ? formatCache.get(id) : undefined;
  if (hit && Date.now() - hit.at < FORMAT_TTL) return hit;
  const raw = await fetchRaw(url);
  return { formats: raw.formats ?? [], duration: raw.duration ?? 0 };
}

export async function getInfo(url: string): Promise<VideoInfo> {
  const raw = await fetchRaw(url);
  const formats: VideoFormat[] = raw.formats ?? [];
  const duration: number = raw.duration ?? 0;

  const sizeOf = (f: VideoFormat | null): number | null =>
    !f ? null : f.filesize ?? f.filesize_approx ?? (f.tbr && duration ? Math.round((f.tbr * 1000 * duration) / 8) : null);

  const bestAudio = pickAudioFormat(formats);
  const bestAudioSize = sizeOf(bestAudio);

  const toOption = (f: VideoFormat): QualityOption => ({
    codec: codecName(f.vcodec),
    formatId: f.format_id,
    tbr: f.tbr ? Math.round(f.tbr) : null,
    sizeEstimate: sizeOf(f) != null ? sizeOf(f)! + (f.acodec === "none" ? bestAudioSize ?? 0 : 0) : null,
  });

  const heights = [...new Set(formats.filter(isUsableVideo).map((f) => f.height!))].sort((a, b) => b - a);
  const qualities = heights.flatMap((h) => {
    const best = pickVideoFormat(formats, h, "best");
    if (!best) return [];
    const h264 = pickVideoFormat(formats, h, "h264");
    const fps = best.fps ?? null;
    return [{
      height: h,
      label: `${h}p${fps && fps > 30 ? Math.round(fps) : ""}`,
      fps,
      best: toOption(best),
      h264: h264 && h264.vcodec!.startsWith("avc1") ? toOption(h264) : null,
    }];
  });

  const abr = bestAudio?.abr ? Math.round(bestAudio.abr) : null;
  return {
    id: raw.id,
    title: raw.title,
    channel: raw.channel ?? raw.uploader ?? "",
    duration,
    thumbnail: raw.thumbnail,
    view_count: raw.view_count,
    upload_date: raw.upload_date,
    webpage_url: raw.webpage_url ?? url,
    qualities,
    audio: [
      { label: "MP3", kind: "mp3", sizeEstimate: bestAudioSize, abr, note: "Universal Â· converted", formatId: bestAudio?.format_id ?? null },
      { label: "M4A", kind: "m4a", sizeEstimate: bestAudioSize, abr, note: "Original AAC Â· no re-encode", formatId: bestAudio?.format_id ?? null },
    ],
  };
}

export type DownloadKind = "video" | "mp3" | "m4a";

export interface DownloadOptions {
  url: string;
  kind: DownloadKind;
  height?: number;
  codec?: CodecPref;
  outputDir: string;
}

function run(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, { windowsHide: true, env: YTDLP_ENV });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("yt-dlp timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else {
        // Surface the raw yt-dlp output in server logs (Render etc.) — the UI only gets the humanized line.
        console.warn(`[yt-dlp] exit ${code}: ${err.trim().split("\n").filter((l) => l.startsWith("ERROR")).join(" | ") || err.trim().slice(0, 300)}`);
        reject(new Error(humanizeError(err || `yt-dlp exited with code ${code}`)));
      }
    });
  });
}

export function humanizeError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("sign in to confirm you're not a bot") || s.includes("sign in to confirm you’re not a bot"))
    return "YouTube is asking this server to prove it isn't a bot. Try again in a minute; if it keeps happening, the server needs fresh YouTube cookies (see DEPLOY.md).";
  if (s.includes("private video")) return "This video is private.";
  if (s.includes("video unavailable")) return "This video is unavailable.";
  if (s.includes("sign in to confirm your age") || s.includes("age-restricted"))
    return "This video is age-restricted and requires sign-in.";
  if (s.includes("not available in your country") || s.includes("geo"))
    return "This video is not available in your region.";
  if (s.includes("is not a valid url") || s.includes("unsupported url"))
    return "That doesn't look like a valid YouTube URL.";
  if (s.includes("getaddrinfo") || s.includes("network") || s.includes("timed out"))
    return "Network error — check your internet connection.";
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR"))
    .pop();
  return line ? line.replace(/^ERROR:\s*(\[\w+\]\s*)?/, "") : stderr.trim().slice(0, 300);
}

export interface Progress {
  percent: number;
  speed?: string;
  eta?: string;
  totalSize?: string;
  stage: "downloading" | "merging" | "converting" | "done";
  part?: number;
  parts?: number;
}

export interface DownloadHandle {
  process: ChildProcess;
  promise: Promise<string>;
  cancel: () => void;
}

const PROGRESS_RE =
  /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+\w+)(?:\s+at\s+([\d.]+\w+\/s|Unknown speed))?(?:\s+ETA\s+([\d:]+|Unknown))?/;
const FORMATS_RE = /Downloading \d+ format\(s\):\s*(\S+)/;

/**
 * Generic yt-dlp selector used only as a fallback when explicit format IDs can't be resolved.
 * For the exact requested height: H.264 MP4, then any MP4 (AV1), then anything (VP9) remuxed into MP4.
 * Only if that height is missing do we fall back to the best available below it. HLS manifests are excluded.
 */
export function videoFormatSelector(h: number): string {
  const chain = (sel: string) => [
    `bestvideo${sel}[vcodec^=avc1]+bestaudio[ext=m4a]`,
    `bestvideo${sel}[ext=mp4]+bestaudio[ext=m4a]`,
    `bestvideo${sel}+bestaudio`,
    `best${sel}`,
  ];
  return [...chain(`[height=${h}][protocol!*=m3u8]`), ...chain(`[height<=${h}][protocol!*=m3u8]`), "best"].join("/");
}

/**
 * Resolves the exact video+audio format IDs for the requested height and codec preference,
 * so the download matches what the UI displayed. Falls back to the generic selector on failure.
 */
async function resolveVideoSelector(url: string, height: number, pref: CodecPref): Promise<string> {
  const generic = videoFormatSelector(height);
  try {
    const { formats } = await getFormats(url);
    const v = pickVideoFormat(formats, height, pref);
    const a = pickAudioFormat(formats);
    if (!v) return generic;
    return `${v.format_id}${a ? "+" + a.format_id : ""}/${generic}`;
  } catch {
    return generic;
  }
}

export async function startDownload(
  opts: DownloadOptions,
  onProgress: (p: Progress) => void
): Promise<DownloadHandle> {
  const args = [
    "--encoding", "utf-8", // otherwise yt-dlp silently drops non-ASCII chars from printed paths on Windows
    "--no-playlist",
    "--newline",
    "--progress",
    "--no-quiet", // --print implies quiet, which would hide [Merger]/[ExtractAudio] stage lines
    "--no-warnings",
    "--force-overwrites", // a new request at the same resolution should produce a fresh file, not reuse an old one
    "--retries", "10",
    "--fragment-retries", "10",
    "--retry-sleep", "http:2",
    "--ffmpeg-location",
    BIN_DIR,
    "--windows-filenames",
    "-o",
    path.join(
      opts.outputDir,
      opts.kind === "video" ? "%(title).150s [%(id)s] %(height)sp.%(ext)s" : "%(title).150s [%(id)s].%(ext)s"
    ),
    "--print",
    "after_move:filepath",
  ];
  if (process.env.YTDLP_COOKIES_FILE) args.push("--cookies", process.env.YTDLP_COOKIES_FILE);

  if (opts.kind === "video") {
    const selector = await resolveVideoSelector(opts.url, opts.height ?? 1080, opts.codec ?? "best");
    args.push("-f", selector, "--merge-output-format", "mp4");
  } else if (opts.kind === "mp3") {
    args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0", "--embed-thumbnail", "--embed-metadata");
  } else {
    args.push("-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a", "--embed-thumbnail", "--embed-metadata");
  }

  args.push(opts.url);

  const child = spawn(YTDLP_PATH, args, { windowsHide: true, env: YTDLP_ENV, detached: process.platform !== "win32" });
  let stderr = "";
  let lastLine = "";
  let cancelled = false;
  let parts = 1;
  const destinations = new Set<string>();

  const handleLine = (line: string) => {
    line = line.trim();
    if (!line) return;
    const f = FORMATS_RE.exec(line);
    if (f) {
      // "401+140" = video + audio streams downloaded separately, then merged.
      parts = f[1].split(/[+,]/).length || 1;
      return;
    }
    if (line.startsWith("[download] Destination:")) {
      // yt-dlp re-prints this when it resumes after a retry, so count distinct files, not lines.
      destinations.add(line.slice("[download] Destination:".length).trim());
      return;
    }
    const m = PROGRESS_RE.exec(line);
    if (m) {
      const local = parseFloat(m[1]);
      const cur = Math.min(Math.max(destinations.size, 1), parts);
      // Combine the video and audio streams into one overall percentage.
      const overall = parts > 1 ? ((cur - 1) * 100 + local) / parts : local;
      onProgress({
        percent: Math.round(overall * 10) / 10,
        totalSize: m[2],
        speed: m[3],
        eta: m[4],
        stage: "downloading",
        part: cur,
        parts,
      });
      return;
    }
    if (line.startsWith("[Merger]")) onProgress({ percent: 100, stage: "merging" });
    else if (line.startsWith("[ExtractAudio]")) onProgress({ percent: 100, stage: "converting" });
    else if (path.isAbsolute(line)) lastLine = line; // the --print after_move:filepath output
  };

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    lines.forEach(handleLine);
  });
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const promise = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (buf) handleLine(buf);
      if (cancelled) {
        // Process tree is gone now, so partial files are unlocked and safe to delete.
        setTimeout(() => cleanupPartials(opts.url, opts.outputDir), 300);
        return reject(new Error("Download cancelled."));
      }
      if (code === 0) {
        onProgress({ percent: 100, stage: "done" });
        resolve(lastLine);
      } else reject(new Error(humanizeError(stderr || `yt-dlp exited with code ${code}`)));
    });
  });

  return {
    process: child,
    promise,
    cancel: () => {
      cancelled = true;
      killTree(child);
    },
  };
}

/**
 * yt-dlp.exe is a PyInstaller bundle: the bootloader spawns a child Python process,
 * so a plain child.kill() leaves the real downloader running. Kill the whole tree.
 */
function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

/** Removes leftovers like "title [id] 1080p.f137.mp4.part" / ".ytdl" after a cancel. */
function cleanupPartials(url: string, outputDir: string) {
  const id = new URL(url).searchParams.get("v");
  if (!id) return;
  try {
    for (const f of readdirSync(outputDir)) {
      if (f.includes(`[${id}]`) && /\.(part|ytdl|f\d+\.\w+)$/.test(f)) {
        try { unlinkSync(path.join(outputDir, f)); } catch {}
      }
    }
  } catch {}
}

export async function getVersion(): Promise<string> {
  return (await run(["--version"], 15_000)).trim();
}

export async function updateYtDlp(): Promise<string> {
  return (await run(["-U"], 120_000)).trim();
}
