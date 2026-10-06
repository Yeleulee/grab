# Deploying Grab

There are three realistic ways to run this, from most to least reliable.

---

## 1. On your own PC (recommended)

This is where it works best: your home IP isn't bot-blocked by YouTube, downloads land straight on your disk, and there's nothing to pay for or get taken down.

```powershell
npm install
npm start          # or double-click start.cmd — it opens the browser for you
```

Keep it running in a terminal, or make it a background task:

```powershell
# One-time: run at login, hidden (uses Windows Task Scheduler)
schtasks /Create /TN "Grab" /SC ONLOGON /RL LIMITED /F ^
  /TR "cmd /c cd /d \"%CD%\" && npm start"
```

**Use it from your phone / other devices on the same Wi-Fi:**

```powershell
$env:HOST="0.0.0.0"; npm start
# then open http://<your-pc-ip>:3000 on the other device
```

Set `APP_PASSWORD=something` if you expose it to the LAN and don't want housemates using it.

---

## 2. On a server you control (Docker: Railway, Fly.io, Render, any VPS)

The included `Dockerfile` builds a Linux image with Node, `yt-dlp` and `ffmpeg`.

### Before you do this — read the risks

| Risk | What happens | Mitigation |
|---|---|---|
| **YouTube bot-blocks datacenter IPs** | Downloads fail with *"Sign in to confirm you're not a bot"* within hours–days of use | Mount a `cookies.txt` from a logged-in browser and set `YTDLP_COOKIES_FILE` (see below). Use a **throwaway Google account** — it may get banned. Residential proxies are the only robust fix and cost money. |
| **Hosting providers remove YouTube downloaders** | Railway/Render/Fly act on YouTube's DMCA or their own AUP; your app disappears | Keep it private (set `APP_PASSWORD`), don't advertise it, don't put "YouTube" in the hostname. |
| **Bandwidth** | Every file goes YouTube → server → you. 1 GB 4K download = 2 GB of transfer on the server | Most free tiers include ~100 GB/mo. Check the plan. |
| **Disk** | Files pile up in `/app/downloads` | Mount a volume and clear it periodically, or treat "Save" as the delivery mechanism and delete after. |

### Environment variables

| Variable | Purpose |
|---|---|
| `HOST=0.0.0.0` | Required in containers (already set in the Dockerfile) |
| `PORT` | Set automatically by most platforms |
| `APP_PASSWORD` | Turns on HTTP Basic Auth (username `grab`, or set `APP_USER`) |
| `YTDLP_COOKIES_FILE` | Path to a Netscape-format `cookies.txt` to get past bot checks |

### Railway

1. Push this folder to a **private** GitHub repo.
2. railway.app → New Project → Deploy from GitHub repo → pick it. Railway detects the `Dockerfile`.
3. Variables tab: add `APP_PASSWORD`. (`HOST`/`PORT` are handled.)
4. Settings → Networking → Generate Domain.
5. Optional: Volumes → add one mounted at `/app/downloads` so files survive redeploys.

### Fly.io

```bash
fly launch --no-deploy          # accept the Dockerfile, pick a region near you
fly secrets set APP_PASSWORD=change-me
fly volumes create downloads --size 10
# add to fly.toml:   [mounts]  source = "downloads"  destination = "/app/downloads"
fly deploy
```

### Any VPS (Hetzner, DigitalOcean, Oracle free tier…)

```bash
git clone <your-repo> grab && cd grab
docker build -t grab .
docker run -d --name grab --restart unless-stopped \
  -p 3000:3000 \
  -v "$PWD/downloads:/app/downloads" \
  -v "$PWD/data:/app/data" \
  -e APP_PASSWORD=change-me \
  grab
```

Put Caddy or nginx in front for HTTPS if you want a domain.

### Getting past "Sign in to confirm you're not a bot"

1. In a browser logged into a **throwaway** Google account, install an extension like *Get cookies.txt LOCALLY* and export `cookies.txt` for `youtube.com`.
2. Mount it into the container, e.g. `-v "$PWD/cookies.txt:/app/cookies.txt:ro"`.
3. Set `YTDLP_COOKIES_FILE=/app/cookies.txt`.
4. Cookies expire; re-export when downloads start failing again.

---

## 3. Vercel / Netlify / Cloudflare Workers — **not possible**

Serverless platforms can't run this: no long-lived processes (downloads take minutes; functions time out at 10–300 s), no 100 MB+ native binaries, no writable disk beyond a tiny `/tmp`, no persistent SSE connections, and their IPs are bot-blocked instantly. You *could* host just the static `public/` folder on Vercel and point it at a backend from option 2, but that buys you nothing over hosting the whole thing on that backend.

---

## Packaging as a desktop app (future)

If you want a double-click `.exe` instead of a browser tab, wrap the existing server in **Tauri** (small, Rust shell) or **Electron**. The server, engine and UI stay exactly as they are; the wrapper just launches `server.ts` and opens a window at `http://127.0.0.1:3000`.
