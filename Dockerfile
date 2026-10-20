# Orange Meet — Node image with two targets:
#   prod (default): production deps only, runs 
#   dev           : adds devDependencies (nodemon, livereload, test client)
# The express + socket.io server also serves the static client in /public.

FROM node:20-alpine AS base
# Tini as PID 1 forwards SIGTERM so  shuts down cleanly.
RUN apk add --no-cache tini
WORKDIR /app
COPY package.json package-lock.json ./

FROM base AS dev
RUN npm ci && npm cache clean --force
COPY nodemon.json server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY test/ ./test/
ENV NODE_ENV=development PORT=4000
EXPOSE 4000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/nodemon", "server.js"]

FROM base AS prod
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3   CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
