# YouTube Video Downloader

Local web app: paste a YouTube link → preview → pick quality (MP4) or audio (MP3/M4A) → download with live progress.
Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp) + [ffmpeg](https://ffmpeg.org/). No API keys needed.

See [PRD.md](./PRD.md) for the full product spec.

## Run

```powershell
npm install
npm run dev        # http://127.0.0.1:3000
```

| Page | Purpose |
|---|---|
| `/` | Landing page (marketing, how it works, quality comparison, FAQ) |
| `/login` | Dedicated sign-in page — Google + email/password, create account, password reset. Redirects to `/app` when sign-in isn't configured or you're already signed in. Honours `?next=/path`. |
| `/app` | The downloader. With Firebase enabled, unauthenticated visits are sent to `/login`. |

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

## Login with Firebase

Sign-in is **off** until the `FIREBASE_*` environment variables are set. Once set, every API call needs a
Firebase ID token, each user sees only their own downloads, and the UI shows a sign-in screen
(Google and/or email/password with create-account and password reset).

**Setup (≈5 minutes):**

1. [console.firebase.google.com](https://console.firebase.google.com) → *Add project* (Analytics optional).
2. *Build → Authentication → Get started*. Under *Sign-in method* enable **Google** and/or **Email/Password**.
3. *Project settings (gear) → Your apps → Web (`</>`)* → register an app → copy the `firebaseConfig` values.
4. Copy `.env.example` to `.env` and fill in the `FIREBASE_*` values. Set `FIREBASE_PROVIDERS` to the methods
   you enabled, e.g. `google` or `google,password`. `.env` is git-ignored (as is every `.env.*` except the
   empty `.env.example` template), so the keys never reach GitHub. Nothing is hard-coded in the source.
5. *Authentication → Settings → Authorized domains*: `localhost` is pre-authorised; add every domain the page is
   served from (here: `grabb-xi.vercel.app`).
6. Restart the server (`npm start`). The log shows `Auth: Firebase (<projectId>)`.
7. Production: the same variables are set on Render (`npm run render:env -- FIREBASE_API_KEY <value>`, etc.),
   then `npm run deploy`. The server serves them to the browser at `/firebase-config.json`.

**How it works**

- Client: `public/auth.js` loads the Firebase SDK from `/vendor/firebase` (served from `node_modules` via an
  import map — no bundler, no CDN; on Vercel a rewrite in `vercel.json` fetches it from Render) and sends `Authorization: Bearer <ID token>`; tokens auto-refresh and a
  stale one is retried once before re-prompting.
- Server: `src/auth.ts` verifies tokens with `jose` against Google's public keys
  (`securetoken@system.gserviceaccount.com`, issuer `https://securetoken.google.com/<projectId>`), so **no
  service-account key is needed**. Static files and `/api/health` stay public; everything else under `/api` is gated.
- Jobs carry the owner's `uid`; `/api/jobs*` is filtered per user. `APP_PASSWORD` (if also set) is still
  accepted for scripts/curl.

The web config is not a secret (Firebase expects it in the browser); access is controlled by the enabled
providers and authorised domains. Seeing `apiKey=…` in the sign-in URL is normal.

**Troubleshooting sign-in**

| Symptom | Cause → fix |
|---|---|
| *“127.0.0.1” isn't an authorised domain* | Firebase only pre-authorises `localhost`. The server now redirects `127.0.0.1` → `localhost`; use `http://localhost:3000`. |
| *“grabb-xi.vercel.app” isn't an authorised domain* | Add that exact host under Authentication → Settings → Authorized domains. |
| *Your browser blocked the sign-in window* | Allow pop-ups for the site and click again, or use the **redirect** button that appears. |
| Redirect sign-in comes back signed out | Chrome/Safari/Firefox block the third-party storage the redirect flow needs ([Firebase docs](https://firebase.google.com/docs/auth/web/redirect-best-practices)). Pop-up is the default for this reason. To make redirect work too, enable the auth proxy below. |
| Nothing happens, no message | Hard-refresh (`Ctrl+F5`) — an old `login.js` kept errors inside the hidden email form. |

**Optional: first-party auth proxy (makes redirect sign-in reliable)**

The server (and a Vercel rewrite) can serve Firebase's sign-in helper from your own domain
(`/__/auth/*` → `<project>.firebaseapp.com/__/auth/*`), which is Firebase's recommended fix. One-time setup:

1. Google Cloud Console → *APIs & Services → Credentials* → open the OAuth 2.0 client named
   **“Web client (auto created by Google Service)”**.
2. Under *Authorized redirect URIs* add `https://grabb-xi.vercel.app/__/auth/handler` and
   `http://localhost:3000/__/auth/handler`. Under *Authorized JavaScript origins* add the two origins.
3. Set `FIREBASE_AUTH_PROXY=1` (in `.env` locally, `npm run render:env -- FIREBASE_AUTH_PROXY 1` on Render)
   and redeploy. The client then uses the page's own host as `authDomain`.

Without step 2, Google rejects the sign-in with `redirect_uri_mismatch`, so leave the flag at `0` until it's done.

## Project layout

```
src/ytdlp.ts            yt-dlp wrapper: URL validation, metadata, format selector, download w/ multi-part progress, cancel (tree-kill + .part cleanup)
src/server.ts           Express API + SSE progress + persisted job history + reveal-in-folder
src/env.ts              loads .env (git-ignored) into process.env before anything else runs
src/auth.ts             Firebase config from FIREBASE_* env vars + ID-token verification (jose + Google JWKS, no service account)
public/                 UI. landing.html/css/js = marketing page · login.html/css/js = sign-in · app.html + app.js + styles.css = the downloader · auth.js = Firebase client
.env.example            template for .env (Firebase keys); copy and fill in, never commit .env
scripts/test-formats.mjs  end-to-end format matrix test
Dockerfile              Container deploy (see Hosting)
render.yaml             Render Blueprint (free plan, auto-deploy, password)
scripts/render.ps1      npm run deploy / vercel:deploy / render:status / render:logs / render:env / render:cookies
scripts/vercel-config.mjs  Vercel build step: writes public/config.js with the Render API URL
vercel.json, .vercelignore Vercel static-frontend config (allowlist upload)
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

Two registers, one typeface (Inter):

**Landing & login** follow the direction of [awwwards.com](https://www.awwwards.com/): light-grey canvas with near-black ink,
oversized uppercase display type (tight −0.045em tracking, 0.9 line-height), a small metadata row above the headline, pill
buttons (black primary / outlined secondary), a huge dark rounded frame showcasing the product (rendered as live HTML, not a
screenshot), a type marquee, calm white card grids, and a split dark/light sign-in layout. Tokens in `public/landing.css`.

**The app** follows the visual language of [inspora.design](https://www.inspora.design/) (measured from their CSS):

| Principle | How it's applied |
|---|---|
| **Five tones only** — `ink #111`, `muted #777`, `line rgba(0,0,0,.09)`, `surface #f3f3f3`, `paper #fff` | All chrome is monochrome. Green/red appear only for *state* (completed / failed / recommended). Dark theme inverts the same five tokens. |
| **Inter, 14px, weights 400–500** | Loaded from rsms.me with Segoe UI fallback. Headlines are 18–22px/500 — calm, not shouty. Tabular numerals for sizes and progress. |
| **Square corners, hairline borders, no shadows or gradients** | Buttons, inputs, menus and cards all have `border-radius: 0` and 1px lines. Depth comes from `surface` fills, not elevation. |
| **Ink-filled primary, surface-filled secondary** | `Fetch` / `Download` are ink; `Show in folder` / settings actions are surface; destructive or tertiary actions are text-only. |
| **Media in frames, metadata as key/value rows** | Thumbnail sits in a `surface` frame; Channel / Duration / Views / Published are a hairline-separated definition list (like Inspora's Industries / Colors / Styles). |
| **Lists, not cards** | Format options are a radio table; downloads are hairline-separated rows with a 2px progress line. |
| **Purposeful micro-states** | Skeleton while fetching, `Video stream → Audio stream → Merging → Completed` progression, toasts on finish/fail, `prefers-reduced-motion` respected. |
| **Responsive** | Breakpoints at 960px (preview stacks), 640px (phone: stacked form, two-line format rows, wrapped job rows, full-width CTA, 16px inputs to stop iOS zoom, 40px+ touch targets) and 380px (small phones). Verified overflow-free from 320px to 1920px. |

Tokens live at the top of `public/styles.css`.

## Hosting — read before deploying

**This cannot run on Vercel** (or Netlify, Cloudflare Workers, or any serverless platform):
long-running child processes, 120 MB+ native binaries, writable disk, and persistent SSE streams are
all outside the serverless model. Only the static frontend can live there — which is exactly how it's deployed
below (Vercel serves the page, Render runs the engine).

It *can* run in a container (Railway, Fly.io, Render, a VPS) using the included `Dockerfile`
(`HOST=0.0.0.0`). Expect problems though:

1. **YouTube blocks datacenter IPs** aggressively ("Sign in to confirm you're not a bot").
   Mitigation requires `--cookies` from a logged-in account or a residential proxy.
2. **Hosting providers take down public YouTube downloaders** (ToS/DMCA). Keep it private.
3. Bandwidth: every download transits your server twice.

The intended deployment is **local** (this machine) or packaged as a desktop app (Tauri/Electron).

### Deploy: Vercel (frontend) + Render (backend)

Already set up:

| Part | Where | What |
|---|---|---|
| Frontend | https://grabb-xi.vercel.app (Vercel project `grab`) | static `public/`; `config.js` is generated at build time with the Render URL |
| Backend + API | https://grab-dkfd.onrender.com (Render service `grab`) | Docker: Express + yt-dlp + ffmpeg, from private repo `Yeleulee/grab` (`main`) |

The Vercel page calls the Render API **directly** (CORS via `ALLOWED_ORIGINS`), so long downloads, live progress
(SSE) and file transfers never pass through Vercel's proxy limits. Sign-in is **Firebase (Google)**: the
`FIREBASE_*` variables are set on Render, and `grabb-xi.vercel.app` must be listed under Firebase →
Authentication → Settings → Authorized domains. An optional shared password also exists
(`npm run render:env -- APP_PASSWORD <something>` then `npm run deploy`) for scripts/curl or Basic-auth access.

Day-to-day, from this folder:

```powershell
npm run deploy                     # commit, push, wait until Render is live, then deploy Vercel
npm run deploy -- "fix title bug"  # same, with a commit message
npm run vercel:deploy              # frontend only
npm run render:status              # last 5 Render deploys + health
npm run render:logs                # stream live backend logs (Ctrl+C to stop)
npm run render:open                # open the app (Vercel URL)
npm run render:env -- KEY VALUE    # set a Render env var (applies on next deploy)
npm run render:cookies             # upload ./cookies.txt to Render + redeploy (see below)
```

A plain `git push` also redeploys Render (auto-deploy is on), but not Vercel. The scripts live in
`scripts/render.ps1` and use the [Render CLI](https://render.com/docs/cli) and [Vercel CLI](https://vercel.com/docs/cli)
(`render login` / `vercel login` once; if a token expires, just log in again).
`render.yaml` describes the Render service as a Blueprint; `vercel.json` + `.vercelignore` (an allowlist: only
`public/` and `scripts/` are uploaded) describe the Vercel side. Adding another frontend domain? Run
`npm run render:env -- ALLOWED_ORIGINS "https://a.vercel.app,https://b.com"` then `npm run deploy`.

On Render the app runs in **hosted mode** (`RENDER` env var): "Show in folder" / "Open folder" are hidden and
you use **Save** to download the finished file to your device.

Free-plan behaviour:
- Sleeps after 15 min without traffic and **wakes automatically** on the next visit (first load ~30–60 s).
  To keep it awake, ping `https://<your-app>.onrender.com/api/health` every 10 min (e.g. UptimeRobot or
  cron-job.org); 750 free hours/month covers one service 24/7.
- The disk is temporary: downloads and history vanish on sleep/redeploy. Save files right after they finish.
- Bandwidth is limited on the free plan; HD videos use it up quickly.

If YouTube answers "Sign in to confirm you're not a bot" (it will, from Render's datacenter IPs):

1. In a **private/incognito** window, log into a **throwaway** Google account on youtube.com.
2. Export cookies for youtube.com in Netscape format (e.g. the *Get cookies.txt LOCALLY* extension), save as
   `cookies.txt` in this folder (git-ignored), then close the private window so the session isn't rotated.
3. `npm run render:cookies` — uploads it as a Render Secret File, redeploys, and checks YouTube works.

Cookies expire after a while; repeat when the error comes back.
