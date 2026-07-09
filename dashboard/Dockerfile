FROM node:20-alpine AS builder

RUN apk add --no-cache libc6-compat

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
# NOT a 'standalone' output image — server.js is a hand-written custom server
# (proxies /automation to Node-RED, HTTP + WebSocket) that needs the regular
# `next build` output plus full production node_modules, not Next's own
# generated/traced standalone bundle. Bigger image than before; that's the
# accepted trade-off for a working custom server (see next.config.ts).
FROM node:20-alpine AS runner

RUN apk add --no-cache ffmpeg docker-cli docker-cli-compose

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
