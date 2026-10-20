# Changelog

## [Unreleased] — 2026-10-17

### Security
- Removed the `/api/proxy` endpoint. It was an open SSRF proxy that also served third-party HTML from the app's origin with CSP stripped. The client never used it.
- The room-creation password now comes from the `CREATE_PASSWORD` env var instead of being hard-coded.
  - In production, if it is unset, room creation is disabled.
  - Outside production a built-in dev password is used.
  - Passwords are compared in constant time.
- Every Socket.IO handler now validates its payload and is wrapped in try/catch. A malformed message or a room named `constructor` can no longer crash the server.
- Signaling relays (`offer`, `answer`, `ice-candidate`, `ss-*`, `youtube-state-to`, targeted `toggle-*`) only reach members of the sender's room.
- YouTube controls require room membership, and video ids, times and actions are validated.
- Reconnect tokens are revoked on kick, leave and grace-period expiry, so a kicked user can no longer rejoin with an old token. Each socket has one live token.
- Socket.IO checks the `Origin` header: same-origin plus `ALLOWED_ORIGINS`. This replaces `cors: "*"`.
- Added rate limits:
  - Room creation: 10 per minute per IP.
  - Join: 20 per minute per socket.
  - All events: 400 per 10 s per socket.
  - Message size: 100 KB maximum.
- Added security headers: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy`. The `X-Powered-By` header is removed.
- Fixed XSS in the client: room names and toast text are now escaped.
- Removed the Tailwind and socket.io CDN scripts. The Socket.IO client is now served by the server, and jQuery is pinned with an SRI hash.
- Moved the inline script to `public/yt-ready.js`, so the CSP no longer needs `unsafe-inline` for scripts.
- Ran `npm audit fix` (lockfile only). Production dependencies now have 0 known vulnerabilities, down from 12 in total.

### Bug fixes
- **Reconnect:** a reconnecting client takes over its existing member slot in a single step. Previously the slot could be lost, or the host could be demoted.
- **Client after a network drop:** the client now sends `reconnect-session` instead of re-requesting to join.
- **Failed reconnect:** the camera and microphone are now released, and a "Session expired" toast is shown.
- **Host leaving:** the remaining participant becomes host, and pending join requests are re-sent to them. Previously the room was orphaned.
- **Accepting requests:** `accept-user` now only accepts sockets that actually requested to join.
- **Join request expiry:** requests now expire after 60 s (`join-expired`), and the host's toast stays up for 60 s to match.
- **Screen share:**
  - A viewer closing the panel no longer stops the sharer's stream.
  - Only one sharer is allowed per room; a second gets `ss-error`.
- **Orphaned rooms:** rooms whose creator disconnects before joining are now deleted.
- **WebRTC:**
  - Old peer connections are closed before they are replaced.
  - Recovery timers are cleared when a peer leaves.
  - Async handlers no longer produce unhandled promise rejections.
  - Early ICE candidates are buffered.
  - Offer glare is resolved with a deterministic tie-break.
  - Turning the camera on after joining without video now renegotiates.
- **Duplicate submits:** double-clicking Create or YouTube Share no longer sends twice.

### UI/UX and accessibility
- Room names are validated in the browser before the password prompt opens: 1–40 letters, numbers, spaces, `.`, `_` or `-`.
- Kick, Leave and Close YouTube now ask for confirmation.
- The lobby shows "Connecting…" or "Server unreachable — retrying…", and Create is disabled while disconnected.
- Room capacity comes from the server (`room-list` now includes `max`) instead of a hard-coded `/2`.
- Pinch-zoom is allowed again (`user-scalable=no` was removed).
- All icon buttons and inputs have accessible names.
  - Mute and camera buttons update their label, `aria-pressed` and tooltip text when toggled.
- Modals:
  - They use `role="dialog"` and `aria-modal`.
  - Focus moves to the first field when a modal opens and returns to the opener when it closes. Escape closes it, and focus is trapped inside.
  - They are scrollable when they would not fit (`max-height: 90dvh`).
- Toasts and the reconnect banner use `aria-live` regions.
- Added visible `:focus-visible` outlines and support for `prefers-reduced-motion`.
- Added `<main>` and `<header>` landmarks.

### Refactoring
- `server.js` now exports `createServer(opts)` and only starts listening when run directly. It shuts down gracefully on SIGTERM/SIGINT.
- Added `lib/validate.js` (input validators) and `lib/rate-limit.js` (fixed-window limiter).
- Merged the duplicated relay and toggle handlers into shared helpers.
- Server logs are quiet in production and test runs.
- `/api/health` now also reports the room count and uptime.

### Tests
- Added a `node:test` suite with 68 tests in `test/`, using `socket.io-client` (new dev dependency).
- `npm test` now runs it: `docker compose run --rm --no-deps -e NODE_ENV=test orange-meet npm test`.

### Docker and configuration
- The `Dockerfile` now has two targets:
  - `dev`: all dependencies, runs nodemon.
  - `prod` (the default last stage): runs `npm ci --omit=dev`, has a `HEALTHCHECK` on `/api/health`, and runs `node server.js`.
- Compose changes:
  - Builds the `dev` target.
  - Healthcheck uses `/api/health`.
  - Loads `.env` when it exists.
  - Bind mounts are read-only and now include `lib/` and `test/`.
  - Restart policy is `unless-stopped`.
  - Livereload is published on `127.0.0.1:35729` only, and now listens on `0.0.0.0`.
- Added `.env.example` and `.gitignore`. `nodemon.json` now watches `lib/`, and it is copied into the dev image.
- Rewrote `README.md` to cover production run, environment, limits and tests.

### Migration and setup notes
- **Production deployments must set `CREATE_PASSWORD`.** Without it, room creation is disabled.
- If the client is served from a different origin than the server, set `ALLOWED_ORIGINS`.
- After pulling, rebuild: `docker compose up -d --build`. The image tag changed to `orange-meet:dev`, and the new `lib/` and `test/` mounts require recreating the container.
- Room names that use characters outside the new allowed set can no longer be created. Rooms are in memory only, so nothing persisted is affected.
