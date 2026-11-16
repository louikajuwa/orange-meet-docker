# Orange Meet

A lightweight 1:1 WebRTC video-meeting app. A single Node.js server (Express 5 + Socket.IO 4) handles signaling and serves the static browser client from `public/`. It all runs in one Docker container.

Features: password-protected room creation, host approval of join requests, kick, YouTube watch-together with synced playback, screen sharing, and automatic reconnect after a page refresh or network blip.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2.24+ (`docker compose`).
- Host port **4001** must be free.
- A modern browser with WebRTC support. Camera and microphone access require `localhost` or HTTPS.

## Run (development)

```bash
docker compose up -d --build
```

This builds the `dev` target of the `Dockerfile` and runs `nodemon server.js` with `NODE_ENV=development`. The `server.js`, `lib/`, `public/` and `test/` directories are bind-mounted read-only, and the server restarts on change. You only need to rebuild (`--build`) when dependencies change.

Open http://localhost:4001 in two browser tabs to create a room and join it.

## Run (production)

```bash
docker build --target prod -t orange-meet:prod .
docker run -d -p 4000:4000 -e CREATE_PASSWORD='<strong password>' orange-meet:prod
```

The production image contains production dependencies only, runs as the unprivileged `node` user with `tini` as PID 1, and has a built-in `HEALTHCHECK` on `/api/health`.

Put it behind a TLS-terminating reverse proxy (for example Nginx) that forwards WebSocket upgrades. Browsers only allow camera and microphone access on HTTPS origins.

## Environment

Copy `.env.example` to `.env` (git-ignored). Compose loads it automatically if it exists.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CREATE_PASSWORD` | *(none)* — **required; if unset, room creation is disabled** | Password needed to create a room. |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated extra browser origins allowed to open Socket.IO connections. Same-origin is always allowed. |
| `PORT` | `4000` | Port the server listens on inside the container. |
| `NODE_ENV` | `development` (compose), `production` (prod image) | Development enables nodemon, livereload and verbose logs. |

## Limits and behaviour

- A server holds at most 10 rooms, each with at most 2 participants.
- Room names may be 1–40 letters, numbers, spaces, `.`, `_` or `-`.
- A join request expires if the host does not answer within 60 seconds.
- A disconnected participant keeps their slot for 15 seconds so a refresh can resume the call.
- When the host leaves, the other participant becomes host.
- Rate limits:
  - Room creation: 10 per minute per IP.
  - Join: 20 per minute per connection.
  - Socket events: 400 per 10 seconds per connection.
- All state is in memory, so a server restart ends every meeting. There is no database and nothing to back up.

## Tests

```bash
docker compose build
docker compose run --rm --no-deps -e NODE_ENV=test orange-meet npm test
```

The tests use the built-in `node:test` runner and `socket.io-client` against an in-process server on an ephemeral port.

## Common commands

```bash
docker compose logs -f              # tail logs; expect "🚀 Orange Meet on :4000"
docker compose ps                   # wait for "Up (healthy)"
docker compose down                 # stop and remove the container
docker compose exec orange-meet sh  # shell into the running container
curl http://localhost:4001/api/health
```

## License

MIT — see [LICENSE](LICENSE).
