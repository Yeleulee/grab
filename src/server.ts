import "./env.js"; // must stay first: loads .env before other modules read process.env
import express, { type Request, type Response } from "express";
import path from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  checkBinaries,
  getInfo,
  getVersion,
  normalizeYouTubeUrl,
  selfTest,
  startDownload,
  updateYtDlp,
  type DownloadHandle,
  type DownloadKind,
  type CodecPref,
  type Progress,
} from "./ytdlp.js";
import { createFirebaseAuth, loadFirebaseConfig } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DOWNLOAD_DIR = path.join(ROOT, "downloads");
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const PORT = Number(process.env.PORT ?? 3000);
// Defaults to loopback for local use; set HOST=0.0.0.0 when running in a container/VPS.
const HOST = process.env.HOST ?? "127.0.0.1";
// On a remote host (Render sets RENDER=true) the browser isn't on this machine, so folder actions are meaningless.
const HOSTED = !!process.env.RENDER || process.env.HOSTED === "1";

mkdirSync(DOWNLOAD_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });

interface Job {
  id: string;
  uid?: string;
  url: string;
  title: string;
  thumbnail?: string;
  kind: DownloadKind;
  height?: number;
  codec?: CodecPref;
  status: "running" | "done" | "error" | "cancelled";
  progress: Progress;
  filePath?: string;
  fileSize?: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  handle?: DownloadHandle;
  listeners: Set<Response>;
}

const jobs = new Map<string, Job>();

function publicJob(j: Job) {
  const { handle, listeners, ...rest } = j;
  const fileExists = !!j.filePath && existsSync(j.filePath);
  return { ...rest, fileName: j.filePath ? path.basename(j.filePath) : undefined, fileExists };
}

function loadHistory() {
  try {
    const list = JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as Omit<Job, "handle" | "listeners">[];
    for (const j of list) {
      // Anything still "running" when the server died is effectively lost.
      if (j.status === "running") { j.status = "error"; j.error = "Interrupted by server restart."; }
      jobs.set(j.id, { ...j, listeners: new Set() });
    }
  } catch {}
}

let saveTimer: NodeJS.Timeout | null = null;
function saveHistory() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const list = [...jobs.values()].map(({ handle, listeners, ...rest }) => rest);
    try { writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2)); } catch {}
  }, 300);
}

function broadcast(job: Job) {
  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of job.listeners) res.write(payload);
  if (job.status !== "running") {
    for (const res of job.listeners) res.end();
    job.listeners.clear();
    saveHistory();
  }
}

loadHistory();

const app = express();
app.use(express.json());

// Origins of separately hosted frontends (e.g. https://grab-xyz.vercel.app) that may call this API.
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    });
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

// Optional password gate for shared/public deployments (set APP_PASSWORD). Local use stays open.
// Same-origin browsers use HTTP Basic auth; a cross-origin frontend can't, so it trades the password for a
// signed, expiring token (POST /api/login) and sends it as a Bearer header or ?token= (EventSource, file links).
const APP_USER = process.env.APP_USER ?? "grab";
const APP_PASSWORD = process.env.APP_PASSWORD;
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

const sign = (payload: string) => createHmac("sha256", APP_PASSWORD!).update(`grab-token:${payload}`).digest("base64url");
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const issueToken = () => {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return `${exp}.${sign(exp)}`;
};
const validToken = (token: string) => {
  const [exp, sig] = token.split(".");
  return !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, sign(exp));
};

if (APP_PASSWORD) {
  app.post("/api/login", (req, res) => {
    const password = String(req.body?.password ?? "");
    if (!safeEqual(password, APP_PASSWORD)) return res.status(401).json({ error: "Wrong password." });
    res.json({ token: issueToken(), expiresInDays: TOKEN_TTL_MS / 86_400_000 });
  });
}

// Firebase Authentication (FIREBASE_* env vars). When configured, every /api route except
// health/login needs a Firebase ID token; the password gate (if any) is still accepted for scripts/curl.
const firebaseCfg = loadFirebaseConfig();
const firebase = firebaseCfg ? createFirebaseAuth(firebaseCfg.projectId) : null;
const expectedBasic = APP_PASSWORD ? `Basic ${Buffer.from(`${APP_USER}:${APP_PASSWORD}`).toString("base64")}` : null;

// The browser SDK needs the web config. It's built from env vars at runtime so no keys live in the repo.
// (Firebase web config is meant to be public; access is enforced by ID-token checks here + Firebase rules.)
const AUTH_PROXY = process.env.FIREBASE_AUTH_PROXY === "1";
app.get("/firebase-config.json", (_req, res) => {
  res.set("Cache-Control", "no-store").json(firebaseCfg ? { ...firebaseCfg, authProxy: AUTH_PROXY } : {});
});

// Reverse-proxy Firebase's sign-in helper pages so the auth flow stays first-party on this domain
// (https://firebase.google.com/docs/auth/web/redirect-best-practices, option 3). This is what makes
// redirect sign-in survive browsers that block third-party storage. The client switches authDomain to
// this host only when FIREBASE_AUTH_PROXY=1 — see README for the one-time Google Cloud step.
if (firebaseCfg) {
  const origin = `https://${firebaseCfg.projectId}.firebaseapp.com`;
  app.use("/__/auth", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
    try {
      const headers: Record<string, string> = {};
      for (const h of ["accept", "accept-language", "content-type", "user-agent", "referer", "cookie"]) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      const upstream = await fetch(origin + req.originalUrl, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : new Uint8Array(req.body as Buffer),
        redirect: "manual",
      });
      res.status(upstream.status);
      upstream.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) res.setHeader(k, v);
      });
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e: any) {
      res.status(502).send(`Auth helper unavailable: ${e.message}`);
    }
  });
}

if (APP_PASSWORD || firebase) {
  app.use("/api", async (req, res, next) => {
    if (req.method === "OPTIONS" || req.path === "/health" || req.path === "/login") return next();
    const auth = req.headers.authorization ?? "";
    if (expectedBasic && safeEqual(auth, expectedBasic)) return next();
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : typeof req.query.token === "string" ? req.query.token : "";
    if (!bearer) return res.status(401).json({ error: "Sign in required." });
    if (APP_PASSWORD && validToken(bearer)) return next();
    if (firebase) {
      try {
        req.user = await firebase.verify(bearer);
        return next();
      } catch (e: any) {
        return res.status(401).json({ error: /exp/i.test(String(e.code ?? e.message)) ? "Session expired — sign in again." : "Invalid session." });
      }
    }
    res.status(401).json({ error: "Authentication required." });
  });
}
// Pages: "/" is the landing page, "/login" the sign-in page, "/app" the downloader.
// Without Firebase there is nothing to sign in to, so /login just forwards to the app.
const page = (file: string) => (_req: Request, res: Response) => res.sendFile(path.join(PUBLIC_DIR, file));
// Firebase pre-authorises "localhost" but not "127.0.0.1"; keep local visitors on the host that works.
app.use((req, res, next) => {
  if (firebase && req.hostname === "127.0.0.1" && req.method === "GET" && !req.path.startsWith("/api/"))
    return res.redirect(302, `http://localhost:${PORT}${req.originalUrl}`);
  next();
});
app.get("/", page("landing.html"));
app.get("/app", page("app.html"));
app.get("/login", (req, res) => (firebase ? page("login.html")(req, res) : res.redirect(302, "/app")));
app.use(express.static(PUBLIC_DIR, { index: false }));
// Serve the Firebase SDK from node_modules so the client needs no bundler or CDN.
app.use("/vendor/firebase", express.static(path.join(ROOT, "node_modules", "firebase"), { immutable: true, maxAge: "7d" }));

/** A job is visible to its owner; legacy jobs without an owner are visible to everyone. */
const canSee = (req: Request, j: Job) => !j.uid || !req.user || j.uid === req.user.uid;
const findJob = (req: Request) => {
  const j = jobs.get(req.params.id as string);
  return j && canSee(req, j) ? j : undefined;
};

// Spawning yt-dlp takes seconds on a small instance; cache the version so health checks stay instant.
let ytdlpVersion: string | null = null;
let versionPending = false;
function refreshVersion() {
  if (versionPending || !checkBinaries().ytdlp) return;
  versionPending = true;
  getVersion()
    .then((v) => (ytdlpVersion = v))
    .catch(() => {})
    .finally(() => (versionPending = false));
}

// PO token provider (bgutil, started by the Dockerfile) — proves to YouTube we're not a bot from a datacenter IP.
// Polled lazily like the version so health checks stay instant; null = not configured (local dev).
const POT_PROVIDER_URL = process.env.POT_PROVIDER_URL;
let potProvider: boolean | null = POT_PROVIDER_URL ? false : null;
let potPending = false;
function refreshPotProvider() {
  if (!POT_PROVIDER_URL || potPending) return;
  potPending = true;
  fetch(`${POT_PROVIDER_URL}/ping`, { signal: AbortSignal.timeout(3000) })
    .then((r) => (potProvider = r.ok))
    .catch(() => (potProvider = false))
    .finally(() => (potPending = false));
}

app.get("/api/health", (_req, res) => {
  const bins = checkBinaries();
  if (!ytdlpVersion) refreshVersion();
  if (potProvider === false) refreshPotProvider();
  res.json({
    ok: bins.ytdlp && bins.ffmpeg,
    binaries: bins,
    ytdlpVersion,
    potProvider,
    downloadDir: DOWNLOAD_DIR,
    hosted: HOSTED,
    auth: { firebase: !!firebase, password: !!APP_PASSWORD },
  });
});

app.post("/api/info", async (req, res) => {
  const url = normalizeYouTubeUrl(String(req.body?.url ?? ""));
  if (!url) return res.status(400).json({ error: "Please enter a valid YouTube URL." });
  try {
    res.json(await getInfo(url));
  } catch (e: any) {
    res.status(422).json({ error: e.message });
  }
});

// Remote diagnostics for "Sign in to confirm you're not a bot": which PO token providers loaded, which player
// clients were tried and what YouTube said. Body: { url?, clients? } — clients overrides YTDLP_PLAYER_CLIENTS once.
app.post("/api/selftest", async (req, res) => {
  const url = normalizeYouTubeUrl(String(req.body?.url ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ"));
  if (!url) return res.status(400).json({ error: "Please enter a valid YouTube URL." });
  const clients = typeof req.body?.clients === "string" && /^[\w,-]+$/.test(req.body.clients) ? req.body.clients : undefined;
  try {
    res.json({ potProvider, ...(await selfTest(url, clients)) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/download", (req, res) => {
  const url = normalizeYouTubeUrl(String(req.body?.url ?? ""));
  const kind = req.body?.kind as DownloadKind;
  const height = req.body?.height != null ? Number(req.body.height) : undefined;
  const codec: CodecPref = req.body?.codec === "h264" ? "h264" : "best";
  const title = String(req.body?.title ?? "");
  const thumbnail = typeof req.body?.thumbnail === "string" && /^https?:\/\//.test(req.body.thumbnail) ? req.body.thumbnail : undefined;

  if (!url) return res.status(400).json({ error: "Please enter a valid YouTube URL." });
  if (!["video", "mp3", "m4a"].includes(kind)) return res.status(400).json({ error: "Invalid format." });
  if (kind === "video" && (height == null || !Number.isFinite(height) || height <= 0))
    return res.status(400).json({ error: "Invalid quality." });

  const job: Job = {
    id: randomUUID(),
    uid: req.user?.uid,
    url,
    title,
    thumbnail,
    kind,
    height,
    codec: kind === "video" ? codec : undefined,
    status: "running",
    progress: { percent: 0, stage: "downloading" },
    createdAt: Date.now(),
    listeners: new Set(),
  };
  jobs.set(job.id, job);
  saveHistory();

  const finish = (status: Job["status"], extra: Partial<Job> = {}) => {
    Object.assign(job, extra, { status, finishedAt: Date.now() });
    broadcast(job);
  };

  // YouTube intermittently returns 403 on fresh stream URLs; one automatic retry fixes most cases.
  const launch = async (attempt: number) => {
    let handle: DownloadHandle;
    try {
      handle = await startDownload({ url, kind, height, codec, outputDir: DOWNLOAD_DIR }, (p) => {
        job.progress = p;
        broadcast(job);
      });
    } catch (e: any) {
      return finish("error", { error: e.message });
    }
    job.handle = handle;
    if (job.status === "cancelled") return handle.cancel(); // cancelled while formats were resolving

    handle.promise
      .then((filePath) => {
        let fileSize: number | undefined;
        try { fileSize = statSync(filePath).size; } catch {}
        finish("done", { filePath, fileSize, progress: { percent: 100, stage: "done" } });
      })
      .catch((e: Error) => {
        if (job.status === "running" && attempt === 0 && /403/.test(e.message)) {
          job.progress = { percent: 0, stage: "downloading" };
          broadcast(job);
          return launch(1);
        }
        if (job.status === "cancelled") return finish("cancelled");
        finish("error", { error: e.message });
      });
  };
  launch(0);

  res.status(202).json(publicJob(job));
});

app.get("/api/jobs", (req, res) => {
  res.json([...jobs.values()].filter((j) => canSee(req, j)).sort((a, b) => b.createdAt - a.createdAt).map(publicJob));
});

app.delete("/api/jobs/finished", (req, res) => {
  for (const [id, j] of jobs) if (j.status !== "running" && canSee(req, j)) jobs.delete(id);
  saveHistory();
  res.json({ ok: true });
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = findJob(req);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status === "running") return res.status(409).json({ error: "Cancel the download first." });
  jobs.delete(job.id);
  saveHistory();
  res.json({ ok: true });
});

/** Opens Explorer/Finder with the file selected. Only meaningful when the browser is on the same machine. */
app.post("/api/jobs/:id/reveal", (req, res) => {
  if (HOSTED) return res.status(400).json({ error: "Not available on a hosted server — use Save." });
  const job = findJob(req);
  if (!job?.filePath || !existsSync(job.filePath)) return res.status(404).json({ error: "File not found on disk." });
  const target = path.resolve(job.filePath);
  if (!target.startsWith(DOWNLOAD_DIR)) return res.status(400).json({ error: "Invalid path." });
  if (process.platform === "win32") spawn("explorer", [`/select,${target}`], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "darwin") spawn("open", ["-R", target], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [path.dirname(target)], { detached: true, stdio: "ignore" }).unref();
  res.json({ ok: true });
});

app.post("/api/open-folder", (_req, res) => {
  if (HOSTED) return res.status(400).json({ error: "Not available on a hosted server — use Save." });
  if (process.platform === "win32") spawn("explorer", [DOWNLOAD_DIR], { detached: true, stdio: "ignore" }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [DOWNLOAD_DIR], { detached: true, stdio: "ignore" }).unref();
  res.json({ ok: true });
});

app.get("/api/jobs/:id/events", (req: Request, res: Response) => {
  const job = findJob(req);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
  if (job.status !== "running") return res.end();

  job.listeners.add(res);
  req.on("close", () => job.listeners.delete(res));
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = findJob(req);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "running") return res.json(publicJob(job));
  job.status = "cancelled";
  job.handle?.cancel();
  res.json(publicJob(job));
});

app.get("/api/jobs/:id/file", (req, res) => {
  const job = findJob(req);
  if (!job?.filePath || job.status !== "done") return res.status(404).json({ error: "File not ready." });
  const resolved = path.resolve(job.filePath);
  if (!resolved.startsWith(DOWNLOAD_DIR) || !existsSync(resolved))
    return res.status(404).json({ error: "File not found." });
  res.download(resolved);
});

app.post("/api/update-engine", async (_req, res) => {
  try {
    res.json({ output: await updateYtDlp() });
    refreshVersion();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => {
  refreshVersion();
  const bins = checkBinaries();
  console.log(`\n  YouTube Downloader running at http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}`);
  console.log(`  yt-dlp: ${bins.ytdlp ? "ok" : "MISSING"}   ffmpeg: ${bins.ffmpeg ? "ok" : "MISSING"}`);
  console.log(`  Saving to: ${DOWNLOAD_DIR}`);
  console.log(`  Auth: ${firebase ? `Firebase (${firebaseCfg!.projectId})` : APP_PASSWORD ? "password" : "none (local)"}\n`);
});
