# Container deploy for Render (see render.yaml), Railway, Fly.io or a VPS.
# NOTE: Vercel cannot run this — see PRD.md §2 / README "Hosting".
# Expect YouTube to bot-block datacenter IPs; you will likely need cookies (YTDLP_COOKIES_FILE) or a proxy.

FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# YouTube requires a JS runtime to solve its challenges; yt-dlp only auto-enables Deno, so point it at Node.
RUN mkdir -p bin downloads data \
  && curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp \
  && chmod +x bin/yt-dlp \
  && ln -s /usr/bin/ffmpeg bin/ffmpeg \
  && ln -s /usr/bin/ffprobe bin/ffprobe \
  && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY public ./public
# Compile once at build time and drop dev deps: plain `node` uses far less CPU/RAM than tsx on a 512 MB free instance.
RUN npm run build && npm prune --omit=dev

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

# Render mounts Secret Files read-only at /etc/secrets; yt-dlp rewrites its cookie jar, so use a writable copy.
CMD ["sh", "-c", "if [ -f /etc/secrets/cookies.txt ]; then cp /etc/secrets/cookies.txt /tmp/cookies.txt && export YTDLP_COOKIES_FILE=/tmp/cookies.txt; fi; exec node dist/server.js"]
