# Container deploy for Render (see render.yaml), Railway, Fly.io or a VPS.
# NOTE: Vercel cannot run this — see PRD.md §2 / README "Hosting".
# YouTube bot-blocks datacenter IPs ("Sign in to confirm you're not a bot"). Two mitigations ship in this image:
#   1. A PO token provider (bgutil) that solves YouTube's BotGuard challenge locally — automatic, no account needed.
#   2. Optional cookies from a logged-in account (YTDLP_COOKIES_FILE / Render Secret File) for when 1 isn't enough.

ARG POT_VERSION=2.0.1

# --- Stage 1: build the PO token provider server (https://github.com/Brainicism/bgutil-ytdlp-pot-provider) ---
FROM node:24-slim AS pot
ARG POT_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /pot
RUN curl -fL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${POT_VERSION}.tar.gz" \
    | tar -xz --strip-components=2 "bgutil-ytdlp-pot-provider-${POT_VERSION}/server" \
  && npm ci --no-audit --no-fund \
  && npx tsc \
  && npm prune --omit=dev

# --- Stage 2: the app ---
FROM node:24-slim
ARG POT_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# YouTube requires a JS runtime to solve its challenges; yt-dlp only auto-enables Deno, so point it at Node.
# The bgutil plugin zip goes in a yt-dlp system plugin folder; it talks to the provider server on 127.0.0.1:4416.
RUN mkdir -p bin downloads data /etc/yt-dlp/plugins \
  && curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp \
  && chmod +x bin/yt-dlp \
  && ln -s /usr/bin/ffmpeg bin/ffmpeg \
  && ln -s /usr/bin/ffprobe bin/ffprobe \
  && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf \
  && curl -fL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${POT_VERSION}/bgutil-ytdlp-pot-provider.zip" \
       -o /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip

COPY --from=pot /pot /opt/bgutil

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY public ./public
# Compile once at build time and drop dev deps: plain `node` uses far less CPU/RAM than tsx on a 512 MB free instance.
RUN npm run build && npm prune --omit=dev

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
# Lets /api/health report whether the PO token provider is up.
ENV POT_PROVIDER_URL=http://127.0.0.1:4416
EXPOSE 3000

# 1. Start the PO token provider in the background (localhost only; yt-dlp's bgutil plugin finds it at the default port).
# 2. Render mounts Secret Files read-only at /etc/secrets; yt-dlp rewrites its cookie jar, so use a writable copy.
CMD ["sh", "-c", "node /opt/bgutil/build/main.js & if [ -f /etc/secrets/cookies.txt ]; then cp /etc/secrets/cookies.txt /tmp/cookies.txt && export YTDLP_COOKIES_FILE=/tmp/cookies.txt; fi; exec node dist/server.js"]
