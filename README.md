# YouTube Video Downloader

Local web app: paste a YouTube link → preview → pick quality (MP4) or audio (MP3/M4A) → download with live progress.
Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [ffmpeg](https://ffmpeg.org/). No API keys needed.

See [PRD.md](./PRD.md) for the full product spec.

## Run

```powershell
npm install
npm run dev        # http://127.0.0.1:3000
```

Binaries live in `bin/` (`yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe`). They're git-ignored; if missing, grab them:

- yt-dlp: https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
- ffmpeg: https://github.com/BtbN/FFmpeg-Builds/releases (win64-gpl zip → copy `ffmpeg.exe` + `ffprobe.exe`)

Downloads are saved to `./downloads/`. Download history persists in `./data/history.json`.

## Testing

```powershell
npm run typecheck                 # TypeScript
npm run test:formats              # downloads every quality + MP3 + M4A, verifies each with ffprobe
$env:ONLY="2160,mp3"; npm run test:formats   # subset
```

The format test uses Big Buck Bunny (Creative Commons) by default; pass another URL as an argument.

## Format selection

Each resolution offers two picks, switchable in the UI (**Prefer: Best quality / Compatibility**):

- **Best quality (default)** — the stream with the highest *perceived* quality at that height: bitrate weighted by
  codec efficiency (H.264 ×1, VP9 ×1.35, AV1 ×1.6). On most videos this is VP9 or AV1, which is also what YouTube
  itself plays in Chrome — YouTube's H.264 encodes often carry noticeably less bitrate. Plays in Chrome, Edge, VLC,
  Windows 11 Media Player, modern phones/TVs.
- **Compatibility** — H.264 only (falls back to best above 1080p, where YouTube has no H.264). For QuickTime,
  older TVs and legacy Windows Media Player.

Selection happens in our code with explicit yt-dlp format IDs, so the codec/bitrate/size shown is exactly what
downloads. HLS manifests are excluded. Audio: MP3 is re-encoded at best VBR; M4A keeps YouTube's original AAC.

## Deploying

See [DEPLOY.md](./DEPLOY.md) — local (recommended, `start.cmd`), LAN sharing, Docker on Railway/Fly/VPS with the
`APP_PASSWORD` gate and `YTDLP_COOKIES_FILE` for bot checks, and why Vercel can't run it.

## Project layout

```
src/ytdlp.ts            yt-dlp wrapper: URL validation, metadata, format selector, download w/ multi-part progress, cancel (tree-kill + .part cleanup)
src/server.ts           Express API + SSE progress + persisted job history + reveal-in-folder
public/                 UI (vanilla HTML/CSS/JS, dark/light theme)
scripts/test-formats.mjs  end-to-end format matrix test
Dockerfile              Container deploy (see Hosting)
render.yaml             Render Blueprint (free plan, auto-deploy, password)
scripts/render.ps1      npm run deploy / render:status / render:logs / render:open
```

## API

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/health` | binary status + yt-dlp version |
| POST | `/api/info` | `{ url }` → title, thumbnail, qualities, audio options |
| POST | `/api/download` | `{ url, kind: "video"\|"mp3"\|"m4a", height?, codec?: "best"\|"h264", title?, thumbnail? }` → job |
| GET  | `/api/jobs` | all jobs (persisted to `data/history.json`) |
| GET  | `/api/jobs/:id/events` | SSE stream of job progress |
| POST | `/api/jobs/:id/cancel` | kill download, delete partial files |
| GET  | `/api/jobs/:id/file` | serve the finished file |
| POST | `/api/jobs/:id/reveal` | open Explorer/Finder with the file selected (local only) |
| DELETE | `/api/jobs/:id` | remove a finished job from history |
| DELETE | `/api/jobs/finished` | clear all finished jobs |
| POST | `/api/open-folder` | open the downloads folder |
| POST | `/api/update-engine` | `yt-dlp -U` |

## Design system

The UI follows the visual language of [inspora.design](https://www.inspora.design/) (measured from their CSS):

| Principle | How it's applied |
|---|---|
| **Five tones only** — `ink #111`, `muted #777`, `line rgba(0,0,0,.09)`, `surface #f3f3f3`, `paper #fff` | All chrome is monochrome. Green/red appear only for *state* (completed / failed / recommended). Dark theme inverts the same five tokens. |
| **Inter, 14px, weights 400–500** | Loaded from rsms.me with Segoe UI fallback. Headlines are 18–22px/500 — calm, not shouty. Tabular numerals for sizes and progress. |
| **Square corners, hairline borders, no shadows or gradients** | Buttons, inputs, menus and cards all have `border-radius: 0` and 1px lines. Depth comes from `surface` fills, not elevation. |
| **Ink-filled primary, surface-filled secondary** | `Fetch` / `Download` are ink; `Show in folder` / settings actions are surface; destructive or tertiary actions are text-only. |
| **Media in frames, metadata as key/value rows** | Thumbnail sits in a `surface` frame; Channel / Duration / Views / Published are a hairline-separated definition list (like Inspora's Industries / Colors / Styles). |
| **Lists, not cards** | Format options are a radio table; downloads are hairline-separated rows with a 2px progress line. |
| **Purposeful micro-states** | Skeleton while fetching, `Video stream → Audio stream → Merging → Completed` progression, toasts on finish/fail, `prefers-reduced-motion` respected. |

Tokens live at the top of `public/styles.css`.

## Hosting — read before deploying

**This cannot run on Vercel** (or Netlify, Cloudflare Workers, or any serverless platform):
long-running child processes, 120 MB+ native binaries, writable disk, and persistent SSE streams are
all outside the serverless model. Only the static frontend could live there.

It *can* run in a container (Railway, Fly.io, Render, a VPS) using the included `Dockerfile`
(`HOST=0.0.0.0`). Expect problems though:

1. **YouTube blocks datacenter IPs** aggressively ("Sign in to confirm you're not a bot").
   Mitigation requires `--cookies` from a logged-in account or a residential proxy.
2. **Hosting providers take down public YouTube downloaders** (ToS/DMCA). Keep it private.
3. Bandwidth: every download transits your server twice.

The intended deployment is **local** (this machine) or packaged as a desktop app (Tauri/Electron).

### Deploy to Render (free)

Already set up: service **grab** → https://grab-dkfd.onrender.com, built from the private repo
`Yeleulee/grab` (`main`). The login is `grab` + the password in `.render-password.txt` (git-ignored, local only).

Day-to-day, from this folder:

```powershell
npm run deploy                     # commit all changes, push, wait until live, health-check
npm run deploy -- "fix title bug"  # same, with a commit message
npm run render:status              # last 5 deploys + health
npm run render:logs                # stream live logs (Ctrl+C to stop)
npm run render:open                # open the app
```

A plain `git push` also redeploys (auto-deploy is on). The scripts live in `scripts/render.ps1` and use the
[Render CLI](https://render.com/docs/cli) (`render login` once; tokens expire periodically, just log in again).
`render.yaml` describes the same service as a Blueprint, in case you ever recreate it from the dashboard.

On Render the app runs in **hosted mode** (`RENDER` env var): "Show in folder" / "Open folder" are hidden and
you use **Save** to download the finished file to your device.

Free-plan behaviour:
- Sleeps after 15 min without traffic and **wakes automatically** on the next visit (first load ~30–60 s).
  To keep it awake, ping `https://<your-app>.onrender.com/api/health` every 10 min (e.g. UptimeRobot or
  cron-job.org); 750 free hours/month covers one service 24/7.
- The disk is temporary: downloads and history vanish on sleep/redeploy. Save files right after they finish.
- Bandwidth is limited on the free plan; HD videos use it up quickly.

If YouTube answers "Sign in to confirm you're not a bot": export `cookies.txt` (Netscape format) from a browser
logged into a **throwaway** Google account, add it in Render → your service → **Environment → Secret Files**
with the filename `cookies.txt`, and redeploy. The container picks it up from `/etc/secrets/cookies.txt`.
