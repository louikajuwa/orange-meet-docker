# Orange Meet — single-stage Node image
# Runs the express + socket.io server, which also serves the static client
# (index.html in /public). Port is configurable via the PORT env var.

FROM node:20-alpine

# Tini is a tiny init that handles SIGTERM/SIGINT properly. Without it,
# `docker stop` waits 10s before SIGKILL because Node-as-PID-1 swallows
# SIGTERM. Cheap (~250KB), saves real time during dev/restart loops.
RUN apk add --no-cache tini

WORKDIR /app

# Copy lockfiles first so `npm ci` is cached when only source changes.
COPY package.json package-lock.json* ./

# `npm ci` is faster and reproducible (uses lockfile exactly).
RUN npm ci && npm cache clean --force

# Server code
COPY server.js ./

# The server serves static files from /app/public via express.static.
# index.html lives there so it's reachable at GET /.
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

# Run as the unprivileged 'node' user that ships in the official image
USER node

# Tini as PID 1 → clean shutdown on `docker stop`
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
