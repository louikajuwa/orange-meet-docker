# Orange Meet

A lightweight WebRTC video-meeting app — a single Node.js (Express 5 + Socket.io) server that handles signaling and serves the static browser client from `public/`, all in one Docker container.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2 (`docker compose`).
- Host port **4001** free.
- A modern browser with WebRTC support (camera/mic permissions) to actually join a meeting.

## Run

```bash
docker compose up -d --build
```

This builds the image from the local `Dockerfile` and starts the single service in the background.

The compose file overrides the image's default `CMD` (`node server.js`) with `nodemon server.js` and sets `NODE_ENV=development`, so `server.js` and `public/` are live-reloaded from the bind mounts — edit locally and the server restarts automatically, no rebuild needed. A rebuild (`--build`) is only required when `package.json`/dependencies change.

## Services

| Service | Image/Build | Purpose | Port (host:container) | URL |
|---------|-------------|---------|-----------------------|-----|
| `orange-meet` | Built from `.` (`node:20-alpine`), tagged `orange-meet:latest`; container name `orange-meet` | Express 5 + Socket.io signaling server that also serves the static WebRTC client from `/app/public` | `4001:4000` | http://localhost:4001 |

`tini` runs as PID 1 inside the container for clean `SIGTERM` handling on `docker stop`. The container runs as the unprivileged `node` user.

## Environment

All values below are set in `docker-compose.yml` — no `.env` file is required.

| Variable | Default (compose) | Purpose |
|----------|-------------------|---------|
| `PORT` | `4000` | Port the server listens on inside the container. The host mapping is `4001:4000`; change the left side of the `ports` entry to publish on a different host port. |
| `NODE_ENV` | `development` | Set to `development` in compose to run under `nodemon` with live-reload. (The image's own default is `production`.) |

## Volumes & persistence

No named volumes. The app is stateless (in-memory signaling only). Two bind mounts are declared for live development:

| Bind mount | Purpose |
|------------|---------|
| `./server.js:/app/server.js` | Live-reload the server code |
| `./public:/app/public` | Live-reload the static WebRTC client |

## Common commands

```bash
docker compose logs -f            # tail logs; expect "🚀 Orange Meet on :4000"
docker compose ps                 # show status; wait for "Up (healthy)"
docker compose stop               # stop the container (keeps it)
docker compose down               # stop and remove the container
docker compose up -d --build      # rebuild the image and restart
docker compose exec orange-meet sh   # shell into the running container
```

There is no database, so there are no migrations or seed steps.

## Verify

Confirm the stack is up:

```bash
curl -I http://localhost:4001    # -> HTTP 200
docker compose ps                # STATUS shows "Up (healthy)"
```

A Docker healthcheck polls `http://localhost:4000/` inside the container every 30s (`wget`), so `docker compose ps` reports `(healthy)` once the server responds.

Then open http://localhost:4001 in two browser tabs (or two devices) to start and join a meeting. There are no accounts or seeded credentials — meetings are open by URL.
