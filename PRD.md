# PRD — YouTube Video Downloader

**Status:** Draft v0.1
**Owner:** Yeleul Engeda
**Last updated:** 2026-10-06

---

## 1. Summary

A desktop-friendly web app (local server + browser UI) that lets a user paste a YouTube URL, pick a quality/format, and download the video or audio to their machine. It runs locally on the user's PC — nothing is uploaded to a third-party service.

---

## 2. The big question first: do we need the YouTube Data API v3 key?

**Short answer: No — and it won't help you download anything.**

| Capability | YouTube Data API v3 | yt-dlp (recommended) |
|---|---|---|
| Fetch title, thumbnail, duration, channel | ✅ | ✅ |
| List available video/audio formats | ❌ | ✅ |
| Get downloadable stream URLs | ❌ (not exposed, by design) | ✅ |
| Download video / audio | ❌ | ✅ |
| Search YouTube | ✅ | ✅ (`ytsearch:` prefix) |
| Playlists / channels | ✅ (metadata only) | ✅ (metadata + download) |
| Requires API key / Google Cloud project | ✅ | ❌ |
| Daily quota limits | ✅ (10,000 units/day) | ❌ |
| Breaks when YouTube changes its player | No | Occasionally — fixed fast by frequent releases |

The Data API is a **metadata API**. Google deliberately never exposes media stream URLs through it, and its Terms of Service prohibit using it to download content. So for the core feature — downloading — the API key is a dead end.

**Recommendation:** Build on **`yt-dlp`** (the actively-maintained successor to youtube-dl) as the download engine, with **`ffmpeg`** for merging video+audio streams and converting to MP3. Optionally add the Data API later *only* if you want quota-free-ish, stable metadata for things like channel browsing — but yt-dlp already covers that too.

### Why yt-dlp over a pure-JS library (`ytdl-core`, `@distube/ytdl-core`, `play-dl`)?
- Pure-JS libs break every few weeks when YouTube rotates its player/signature code; many are abandoned.
- yt-dlp ships fixes within days, handles signature deciphering, throttling (`n` param), age-gating, playlists, subtitles, 1000+ other sites.
- Trade-off: it's a Python-based binary we must bundle/download. That's fine — we ship the single-file `yt-dlp.exe`.

---

## 3. Goals & Non-Goals

### Goals
1. Paste URL → see preview (thumbnail, title, duration, channel) in < 3 s.
2. Choose quality (e.g. 1080p / 720p / 480p / 360p) or audio-only (MP3 / M4A).
3. Download with live progress (%, speed, ETA) and a cancel button.
4. Works fully offline-local: only talks to YouTube, no middleman server.
5. Zero configuration for the user — no API keys, no accounts.
6. Playlist support (download all or selected items).

### Non-Goals (v1)
- Hosting this publicly as a SaaS (legal exposure + bandwidth; see §9).
- DRM-protected content (YouTube Movies/Premium rentals) — impossible and illegal.
- Live stream recording.
- Mobile app.
- Editing/trimming videos.

---

## 4. Target Users

- **Primary:** A single person on Windows who wants to save videos for offline viewing, lectures for study, or music for personal use.
- **Secondary:** Developers who want a self-hosted tool on their LAN.

---

## 5. User Stories

| # | As a user I want… | So that… | Priority |
|---|---|---|---|
| U1 | to paste a YouTube link and see what the video is | I know I got the right one | P0 |
| U2 | to pick a resolution | I can balance quality vs. file size | P0 |
| U3 | to download audio-only as MP3 | I can listen to music/podcasts | P0 |
| U4 | to see progress and cancel | I'm not left guessing | P0 |
| U5 | to choose where files are saved | my downloads are organized | P1 |
| U6 | to paste a playlist link and download all videos | I don't repeat myself 50 times | P1 |
| U7 | to see a history of past downloads | I can re-open files | P2 |
| U8 | to download subtitles / captions | I can study with transcripts | P2 |
| U9 | to queue multiple downloads | I can walk away | P2 |
| U10 | to embed thumbnail + metadata in MP3s | my music library looks right | P2 |

---

## 6. Functional Requirements

### 6.1 URL input & validation
- Accept `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`, `youtube.com/playlist?list=`, and `music.youtube.com` URLs.
- Reject non-YouTube URLs with a clear message (v1 scope; yt-dlp supports more sites later).
- Strip tracking params (`si=`, `feature=`) before passing to the engine.

### 6.2 Metadata preview
- Run `yt-dlp -J <url>` (JSON dump, no download) → show title, channel, duration, thumbnail, view count, upload date.
- Show list of available formats grouped as:
  - **Video (MP4):** best combined video+audio per resolution.
  - **Audio only:** MP3 (converted), M4A (native).
- Cache metadata per video ID for the session.

### 6.3 Download
- Spawn `yt-dlp` as a child process with:
  - `-f "bestvideo[height<=H][ext=mp4]+bestaudio[ext=m4a]/best[height<=H]"` for video.
  - `-x --audio-format mp3 --audio-quality 0` for MP3.
  - `--newline --progress` for parseable progress output.
  - `-o "<outputDir>/%(title)s [%(id)s].%(ext)s"` with filename sanitization.
  - `--no-playlist` unless user explicitly chose playlist mode.
- Parse stdout progress lines → stream to UI via Server-Sent Events (SSE) or WebSocket.
- Support cancel (kill process, delete `.part` file).
- Handle errors: video unavailable, private, geo-blocked, age-restricted, network failure — surface a human-readable message.

### 6.4 Playlist mode
- Fetch flat playlist (`--flat-playlist -J`), show items with checkboxes.
- Download selected items sequentially (configurable concurrency 1–3).

### 6.5 Settings
- Output directory (default `~/Downloads/YouTube`).
- Default quality.
- Max concurrent downloads.
- Auto-update yt-dlp on launch (`yt-dlp -U`) toggle.

### 6.6 Dependency management
- On first run, detect `yt-dlp.exe` and `ffmpeg.exe` in `./bin/`.
- If missing, download them from official GitHub releases with a progress indicator and verify checksums.

---

## 7. Non-Functional Requirements

| Area | Requirement |
|---|---|
| Performance | Metadata fetch ≤ 3 s; download speed limited only by network. |
| Reliability | Graceful failure when yt-dlp breaks; "Update engine" button as first-line fix. |
| Security | Server binds to `127.0.0.1` only. All shell args passed as arrays (never string-interpolated) to prevent command injection. Filenames sanitized. |
| Portability | Windows first; macOS/Linux via same codebase (only binary download URLs differ). |
| Privacy | No telemetry. No external calls except YouTube and GitHub (for binaries). |
| Accessibility | Keyboard-navigable, sufficient contrast, progress announced via `aria-live`. |

---

## 8. Proposed Architecture

```
┌──────────────────────────────┐
│  Browser UI (React + Vite)   │  ← paste URL, pick format, watch progress
└──────────────┬───────────────┘
               │ HTTP / SSE  (localhost:3000)
┌──────────────▼───────────────┐
│  Node.js backend (Express)   │
│  - /api/info      → metadata │
│  - /api/download  → start    │
│  - /api/progress  → SSE      │
│  - /api/cancel               │
│  - /api/settings             │
└──────────────┬───────────────┘
               │ child_process.spawn (args array)
┌──────────────▼───────────────┐
│  bin/yt-dlp.exe + ffmpeg.exe │  ← download engine + muxing/transcoding
└──────────────────────────────┘
```

### Tech stack (matches what's already on this machine: Node 24, no Python)
- **Runtime:** Node.js 24 (TypeScript).
- **Backend:** Express (or Fastify) + `child_process`.
- **Frontend:** React + Vite + Tailwind. Alternative: plain HTML if you want zero build step.
- **Engine:** `yt-dlp` standalone binary (no Python install needed) + `ffmpeg` static build.
- **Packaging (optional, v2):** Electron or Tauri to ship as a single desktop `.exe`.

### Alternative stacks considered
| Option | Pros | Cons |
|---|---|---|
| Python + Flask + `yt_dlp` pip package | Native integration, no binary | Python not installed here; harder to package |
| Pure Node (`@distube/ytdl-core`) | No external binary | Fragile; frequent breakage; no ffmpeg anyway for 1080p+ |
| CLI-only (no UI) | Fastest to build | Not user-friendly; "just use yt-dlp" |
| Browser extension | Convenient | Chrome Web Store bans YouTube downloaders |

---

## 9. Legal & Policy Considerations (read this)

- **YouTube Terms of Service** prohibit downloading content without explicit permission (download button, Premium offline). Building/using a downloader for personal use is a ToS violation, not typically a criminal matter, but **distributing it publicly or hosting it as a service carries real risk** (DMCA, account bans, hosting takedowns).
- **Copyright:** Downloading copyrighted content for redistribution is infringement. Personal/educational use varies by jurisdiction.
- **Scope this as a personal/local tool.** Add a disclaimer on first launch. Do not add features aimed at piracy (bulk channel ripping, re-uploading).
- Using the Data API would *not* make this more compliant — the API ToS explicitly forbid downloading.

---

## 10. Milestones

| Phase | Deliverable | Est. |
|---|---|---|
| **M0 — Setup** | Repo, TS config, download yt-dlp + ffmpeg into `bin/`, verify `yt-dlp --version` works | 0.5 day |
| **M1 — Core CLI wrapper** | Node module: `getInfo(url)`, `download(url, opts, onProgress)`, `cancel()` with tests | 1 day |
| **M2 — API** | Express routes + SSE progress + error mapping | 1 day |
| **M3 — UI MVP** | Paste → preview → pick format → download w/ progress (U1–U4) | 2 days |
| **M4 — Settings & output dir** | U5, persisted to JSON config | 0.5 day |
| **M5 — Playlists & queue** | U6, U9 | 1.5 days |
| **M6 — Polish** | History, subtitles, MP3 tagging (U7, U8, U10), auto-update engine | 2 days |
| **M7 (optional)** | Package as desktop app (Tauri/Electron) | 2 days |

---

## 11. Success Metrics

- Paste-to-preview success rate ≥ 95% on public videos.
- Download completion rate ≥ 95% (excluding unavailable/private videos).
- Time from clone to first successful download ≤ 5 minutes for a new developer.
- Zero command-injection vectors (verified by test with hostile URLs/titles).

---

## 12. Open Questions

1. Web UI in browser (simplest) vs. packaged desktop app (nicer, more work)? → **Recommend: start web, package later.**
2. Should v1 support non-YouTube sites since yt-dlp does for free? → Recommend: hide behind a setting; keep YouTube-first UX.
3. Default to MP4 (H.264) only, or also offer WebM/VP9/AV1 originals? → Recommend: MP4 default, "advanced" toggle for raw formats.
4. Do we want a per-user history DB (SQLite) or just a JSON file? → JSON file for v1.

---

## 13. What you'll need (checklist)

- [x] Node.js 24 — already installed
- [ ] `yt-dlp.exe` — https://github.com/yt-dlp/yt-dlp/releases (single file, ~15 MB)
- [ ] `ffmpeg.exe` — https://www.gyan.dev/ffmpeg/builds/ or https://github.com/BtbN/FFmpeg-Builds (static Windows build)
- [ ] Git repo initialized
- [ ] **NOT needed:** YouTube Data API v3 key, Google Cloud project, OAuth
