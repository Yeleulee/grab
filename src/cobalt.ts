/**
 * Cobalt API client — an alternative download engine that bypasses YouTube's bot detection
 * by delegating extraction to Cobalt instances (self-hosted on Railway/Docker or public).
 *
 * Cobalt instances handle their own bot-detection, cookies, and PO tokens, making this
 * completely immune to datacenter IP blocks on the Grab server.
 */

import { createWriteStream, mkdirSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import type { VideoInfo } from "./ytdlp.js";

// ---------------------------------------------------------------------------
//  Cobalt instances
// ---------------------------------------------------------------------------
const DEFAULT_INSTANCES = [
  "https://bergung-api.hoffnungfuerdiezukunft.net",
  "https://cobalt-alpha.wolfy.love",
  "https://cobalt-api.meowing.de",
  "https://cobalt-api.girlskissing.top",
];

function getInstances(): string[] {
  const custom = process.env.COBALT_API_URL;
  if (custom) {
    return [custom.replace(/\/+$/, ""), ...DEFAULT_INSTANCES];
  }
  return DEFAULT_INSTANCES;
}

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------
export interface CobaltSuccess {
  status: "tunnel" | "redirect";
  url: string;
  filename?: string;
}

export interface CobaltPicker {
  status: "picker";
  picker: { url: string; thumb?: string }[];
}

export interface CobaltError {
  status: "error";
  error?: { code?: string; context?: Record<string, any> };
  text?: string;
}

export type CobaltResponse = CobaltSuccess | CobaltPicker | CobaltError;

export interface CobaltDownloadOptions {
  url: string;
  kind: "video" | "mp3" | "m4a";
  height?: number;
  codec?: "h264" | "best";
  outputDir: string;
  title?: string;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

// ---------------------------------------------------------------------------
//  Core Cobalt Request with multi-instance failover
// ---------------------------------------------------------------------------
async function cobaltRequest(body: Record<string, any>, signal?: AbortSignal): Promise<CobaltSuccess> {
  const instances = getInstances();
  let lastError: Error | null = null;

  for (const instance of instances) {
    try {
      console.log(`[cobalt] Contacting instance: ${instance}`);
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      };

      if (process.env.COBALT_API_KEY) {
        headers["Authorization"] = `Api-Key ${process.env.COBALT_API_KEY}`;
      } else if (process.env.COBALT_AUTH_TOKEN) {
        headers["Authorization"] = `Bearer ${process.env.COBALT_AUTH_TOKEN}`;
      }

      // Merge user cancellation signal with timeout
      const timeoutSignal = AbortSignal.timeout(30_000);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const res = await fetch(`${instance}/`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[cobalt] ${instance} returned ${res.status}: ${text.slice(0, 200)}`);
        lastError = new Error(`Cobalt ${instance} returned HTTP ${res.status}`);
        continue;
      }

      const data = (await res.json()) as CobaltResponse;

      if (data.status === "error") {
        const code = (data.error as any)?.code;
        const msg = data.text ?? code ?? "Unknown Cobalt error";
        console.warn(`[cobalt] ${instance} error: ${msg}`);
        lastError = new Error(`Cobalt error: ${msg}`);
        continue;
      }

      if (data.status === "picker") {
        if (data.picker?.length) {
          console.log(`[cobalt] Picker response received, using first option`);
          return { status: "tunnel", url: data.picker[0].url };
        }
        lastError = new Error("Cobalt returned an empty picker");
        continue;
      }

      if (data.status === "tunnel" || data.status === "redirect") {
        console.log(`[cobalt] Success via ${instance} (${data.status})`);
        return data;
      }

      lastError = new Error(`Unrecognised Cobalt response status: ${(data as any).status}`);
    } catch (e: any) {
      if (signal?.aborted) throw e;
      console.warn(`[cobalt] ${instance} request failed: ${e.message}`);
      lastError = e;
    }
  }

  throw lastError ?? new Error("All Cobalt instances failed");
}

function sanitiseFilename(title: string): string {
  return (
    title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 150) || "download"
  );
}

// ---------------------------------------------------------------------------
//  Download a file via Cobalt to outputDir
// ---------------------------------------------------------------------------
export async function cobaltDownload(opts: CobaltDownloadOptions): Promise<string> {
  const isAudio = opts.kind === "mp3" || opts.kind === "m4a";

  // Build a dual-schema body (Cobalt v7 & v10)
  const body: Record<string, any> = {
    url: opts.url,
    filenameStyle: "nerdy",
    filenamePattern: "nerdy",
  };

  if (isAudio) {
    body.downloadMode = "audio";
    body.isAudioOnly = true;
    body.audioFormat = opts.kind === "mp3" ? "mp3" : "best";
    body.aFormat = body.audioFormat;
  } else {
    body.downloadMode = "auto";
    const qualityStr = opts.height ? String(opts.height) : "1080";
    body.videoQuality = qualityStr;
    body.vQuality = qualityStr;
    body.youtubeVideoCodec = opts.codec === "h264" ? "h264" : "h264";
    body.vCodec = "h264";
  }

  const result = await cobaltRequest(body, opts.signal);

  const ext = isAudio ? (opts.kind === "mp3" ? ".mp3" : ".m4a") : ".mp4";
  const baseName = sanitiseFilename(opts.title || "video");

  let videoId = "";
  try {
    const parsed = new URL(opts.url);
    videoId = parsed.searchParams.get("v") ?? "";
  } catch {}

  const filename = videoId
    ? `${baseName} [${videoId}]${!isAudio && opts.height ? ` ${opts.height}p` : ""}${ext}`
    : `${baseName}${ext}`;

  mkdirSync(opts.outputDir, { recursive: true });
  const filePath = path.join(opts.outputDir, filename);

  console.log(`[cobalt] Streaming media to: ${filePath}`);

  const timeoutSignal = AbortSignal.timeout(15 * 60_000);
  const combinedSignal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  const downloadRes = await fetch(result.url, {
    signal: combinedSignal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    },
  });

  if (!downloadRes.ok || !downloadRes.body) {
    throw new Error(`Failed to fetch media from Cobalt stream: HTTP ${downloadRes.status}`);
  }

  const totalSize = Number(downloadRes.headers.get("content-length") || 0);
  let downloaded = 0;
  let lastReportedPercent = -1;

  const reader = downloadRes.body.getReader();
  const ws = createWriteStream(filePath);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      ws.write(value);
      downloaded += value.byteLength;

      if (totalSize > 0 && opts.onProgress) {
        const pct = Math.min(99, Math.round((downloaded / totalSize) * 100));
        if (pct !== lastReportedPercent) {
          lastReportedPercent = pct;
          opts.onProgress(pct);
        }
      }
    }
  } catch (err) {
    ws.destroy();
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch {}
    }
    throw err;
  } finally {
    ws.end();
    await new Promise<void>((resolve, reject) => {
      ws.on("finish", resolve);
      ws.on("error", reject);
    });
  }

  console.log(`[cobalt] Download finished: ${filePath} (${downloaded} bytes)`);
  return filePath;
}

// ---------------------------------------------------------------------------
//  Fallback Video Info using YouTube's oEmbed endpoint
//  Used when yt-dlp is blocked by YouTube's bot detection on /api/info
// ---------------------------------------------------------------------------
export async function getFallbackVideoInfo(url: string): Promise<VideoInfo> {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetch(oembedUrl, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Could not fetch video metadata from YouTube (HTTP ${res.status}).`);
  }

  const data: any = await res.json();
  let videoId = "";
  try {
    const u = new URL(url);
    videoId = u.searchParams.get("v") || u.pathname.replace(/^\//, "");
  } catch {}

  const standardHeights = [1080, 720, 480, 360];
  const qualities = standardHeights.map((h) => ({
    height: h,
    label: `${h}p`,
    fps: 30,
    best: { codec: "H.264", formatId: `cobalt-${h}`, tbr: null, sizeEstimate: null },
    h264: { codec: "H.264", formatId: `cobalt-${h}-h264`, tbr: null, sizeEstimate: null },
  }));

  const audio = [
    { label: "MP3 Audio (Cobalt Engine)", kind: "mp3" as const, sizeEstimate: null, abr: 192, note: "Audio", formatId: "cobalt-mp3" },
    { label: "M4A Audio (Cobalt Engine)", kind: "m4a" as const, sizeEstimate: null, abr: 128, note: "Audio", formatId: "cobalt-m4a" },
  ];

  return {
    id: videoId || "video",
    title: data.title || "YouTube Video",
    channel: data.author_name || "YouTube",
    duration: 0,
    thumbnail: data.thumbnail_url || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ""),
    webpage_url: url,
    qualities,
    audio,
  };
}

// ---------------------------------------------------------------------------
//  Health check for Cobalt
// ---------------------------------------------------------------------------
export async function checkCobaltHealth(): Promise<{ ok: boolean; instance?: string; selfHosted: boolean }> {
  const custom = process.env.COBALT_API_URL;
  if (!custom) {
    return { ok: false, selfHosted: false };
  }
  const cleanUrl = custom.replace(/\/+$/, "");
  try {
    const res = await fetch(`${cleanUrl}/`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(process.env.COBALT_API_KEY ? { Authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {}),
      },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" }),
      signal: AbortSignal.timeout(6000),
    });
    return { ok: res.ok, instance: cleanUrl, selfHosted: true };
  } catch {
    return { ok: false, instance: cleanUrl, selfHosted: true };
  }
}
