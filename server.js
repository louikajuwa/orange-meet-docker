"use strict";
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");
const v = require("./lib/validate");
const { RateLimiter } = require("./lib/rate-limit");

const MAX_ROOMS = 10;
const MAX_MEMBERS = 2;
const RECONNECT_GRACE_MS = 15_000;
const SESSION_TTL_MS = 60 * 60_000;
const JOIN_REQUEST_TTL_MS = 60_000;
const MAX_PAYLOAD_BYTES = 100_000; // SDP offers are a few KB; nothing legit is bigger
// Used only outside production when CREATE_PASSWORD is not set.
const DEV_CREATE_PASSWORD = "REMOVED";

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest();
const passwordMatches = (given, expected) =>
  typeof given === "string" && crypto.timingSafeEqual(sha256(given), sha256(expected));

function securityHeaders({ livereload }) {
  const lr = livereload ? " http://localhost:35729" : "";
  const csp = [
    "default-src 'self'",
    `script-src 'self' https://code.jquery.com https://www.youtube.com https://s.ytimg.com${lr}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://i.ytimg.com",
    "media-src 'self' blob: mediastream:",
    `connect-src 'self'${livereload ? " ws://localhost:35729" : ""}`,
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  return (req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
    next();
  };
}

/**
 * Builds the HTTP + Socket.IO server without listening, so tests can start it
 * on an ephemeral port. All room/session state lives in memory.
 */
function createServer(opts = {}) {
  const env = opts.env || process.env;
  const isProd = env.NODE_ENV === "production";
  const graceMs = opts.graceMs ?? RECONNECT_GRACE_MS;
  const joinRequestTtlMs = opts.joinRequestTtlMs ?? JOIN_REQUEST_TTL_MS;
  const createPassword = env.CREATE_PASSWORD || (isProd ? null : DEV_CREATE_PASSWORD);
  const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const verbose = !isProd && env.NODE_ENV !== "test";
  const log = (...a) => { if (verbose) console.log(...a); };

  if (!createPassword) console.warn("⚠️  CREATE_PASSWORD is not set — room creation is disabled.");

  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders({ livereload: !!opts.livereload }));
  if (opts.livereload) {
    const livereload = require("livereload");
    const connectLR = require("connect-livereload");
    // 0.0.0.0 so the published container port reaches it (compose binds the
    // host side to 127.0.0.1 only).
    const lrServer = livereload.createServer({ host: "0.0.0.0", exts: ["html", "css", "js"], delay: 150 });
    lrServer.watch(path.join(__dirname, "public"));
    app.use(connectLR());
  }
  app.get("/api/health", (req, res) =>
    res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
  app.use(express.static(path.join(__dirname, "public")));

  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: MAX_PAYLOAD_BYTES,
    // Browsers send Origin on both polling and WebSocket upgrades; WebSockets
    // ignore CORS, so origin must be checked here. Clients without an Origin
    // header (non-browser) are allowed — they can't ride a user's session.
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin) return cb(null, true);
      let host;
      try { host = new URL(origin).host; } catch { return cb(null, false); }
      cb(null, host === req.headers.host || allowedOrigins.includes(origin));
    },
  });

  /** name -> { owner, members: string[], pending: Map<id, timer>, youtube, sharer } */
  const rooms = new Map();
  /** token -> { socketId, room, timer } */
  const sessions = new Map();
  /** socketId -> token (one live session token per socket) */
  const tokenBySocket = new Map();

  const createLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });   // per IP
  const joinLimiter = new RateLimiter({ limit: 20, windowMs: 60_000 });     // per socket
  const eventLimiter = new RateLimiter({ limit: 400, windowMs: 10_000 });   // per socket, all events

  const roomList = () =>
    [...rooms].map(([name, rd]) => ({ name, count: rd.members.length, max: MAX_MEMBERS }));

  const emitMemberList = (room, rd) =>
    io.to(room).emit("member-list", {
      members: rd.members.map((id) => ({ id, isOwner: id === rd.owner })),
      ownerId: rd.owner,
    });

  function revokeSession(socketId) {
    const token = tokenBySocket.get(socketId);
    if (!token) return;
    const sess = sessions.get(token);
    if (sess) clearTimeout(sess.timer);
    sessions.delete(token);
    tokenBySocket.delete(socketId);
  }

  function issueSession(sock, room) {
    revokeSession(sock.id);
    const token = crypto.randomBytes(16).toString("hex");
    const timer = setTimeout(() => {
      sessions.delete(token);
      if (tokenBySocket.get(sock.id) === token) tokenBySocket.delete(sock.id);
    }, SESSION_TTL_MS);
    timer.unref();
    sessions.set(token, { socketId: sock.id, room, timer });
    tokenBySocket.set(sock.id, token);
    sock.emit("session-token", { token, room });
  }

  function removePending(rd, id) {
    const timer = rd.pending.get(id);
    if (timer === undefined) return false;
    clearTimeout(timer);
    rd.pending.delete(id);
    return true;
  }

  function clearPendingEverywhere(id) {
    for (const rd of rooms.values()) removePending(rd, id);
  }

  function deleteRoom(room, rd) {
    for (const pid of rd.pending.keys()) {
      removePending(rd, pid);
      io.to(pid).emit("join-rejected", room);
    }
    rooms.delete(room);
  }

  /** Puts `sock` into the room as a member (idempotent) and syncs everyone. */
  function addMember(sock, room) {
    const rd = rooms.get(room);
    if (!rd) return;
    if (sock.data.room && sock.data.room !== room) removeMember(sock.id, sock.data.room);
    clearPendingEverywhere(sock.id);
    if (!rd.members.includes(sock.id)) rd.members.push(sock.id);
    sock.join(room);
    sock.data.room = room;
    delete sock.data.pendingRoom;
    sock.emit("users", rd.members.filter((id) => id !== sock.id));
    sock.to(room).emit("user-joined", sock.id);
    io.to(room).emit("room-count", rd.members.length);
    emitMemberList(room, rd);
    if (rd.youtube) {
      const yt = rd.youtube;
      let currentTime = yt.currentTime;
      if (yt.action === "play") currentTime += (Date.now() - yt.updatedAt) / 1000;
      sock.emit("youtube-shared", { videoId: yt.videoId, currentTime, action: yt.action });
    }
    issueSession(sock, room);
    io.emit("update-rooms");
  }

  /**
   * Removes member `id` from `room`. Works for disconnected sockets too.
   * Revokes the member's reconnect token, hands ownership to the next member
   * and deletes the room when it becomes empty.
   */
  function removeMember(id, room) {
    const rd = room && rooms.get(room);
    if (!rd || !rd.members.includes(id)) return;
    rd.members = rd.members.filter((m) => m !== id);
    revokeSession(id);
    const sock = io.sockets.sockets.get(id);
    if (sock) {
      sock.leave(room);
      if (sock.data.room === room) delete sock.data.room;
    }
    if (rd.sharer === id) {
      rd.sharer = null;
      io.to(room).emit("ss-stop", {});
    }
    io.to(room).emit("user-left", id);

    if (rd.members.length === 0) {
      deleteRoom(room, rd);
    } else {
      if (rd.owner === id) {
        rd.owner = rd.members[0];
        // Pending requests were addressed to the old host — re-route them.
        for (const pid of rd.pending.keys()) io.to(rd.owner).emit("join-request", { room, userId: pid });
      }
      io.to(room).emit("room-count", rd.members.length);
      emitMemberList(room, rd);
    }
    io.emit("update-rooms");
  }

  io.on("connection", (socket) => {
    log("✅ Connected:", socket.id);
    const ip = socket.handshake.address;

    // Global per-socket flood guard: excess packets are silently dropped.
    socket.use((packet, next) => { if (eventLimiter.take(socket.id)) next(); });

    // Every handler is wrapped so a malformed payload can never throw out of
    // the event loop and crash the whole process.
    const on = (event, fn) =>
      socket.on(event, (...args) => {
        try { fn(...args); } catch (err) { console.error(`[${event}] handler error:`, err); }
      });

    const myRoom = () => {
      const room = socket.data.room;
      const rd = room && rooms.get(room);
      return rd && rd.members.includes(socket.id) ? { room, rd } : null;
    };
    /** True if `to` is another member of the sender's current room. */
    const isRoommate = (to) => {
      const cur = myRoom();
      return !!cur && v.isSocketId(to) && to !== socket.id && cur.rd.members.includes(to);
    };

    // --- Reconnect ---
    // A session token lets a client that lost its socket (refresh, network
    // blip) take over its old member slot while that slot is still within the
    // disconnect grace period. Kicked/left members have their token revoked.
    on("reconnect-session", (data) => {
      const token = v.isPlainObject(data) && typeof data.token === "string" ? data.token : null;
      const sess = token && sessions.get(token);
      const rd = sess && rooms.get(sess.room);
      if (!sess || !rd || sess.room !== data.room || !rd.members.includes(sess.socketId)) {
        return socket.emit("reconnect-failed");
      }
      const room = sess.room;
      const previousId = sess.socketId;
      if (previousId !== socket.id) {
        rd.members = rd.members.map((id) => (id === previousId ? socket.id : id));
        if (rd.owner === previousId) rd.owner = socket.id;
        if (rd.sharer === previousId) { rd.sharer = null; socket.to(room).emit("ss-stop", {}); }
        revokeSession(previousId);
        const oldSock = io.sockets.sockets.get(previousId);
        if (oldSock) { oldSock.leave(room); delete oldSock.data.room; }
        // Others drop the stale peer/tile; addMember then announces the new id.
        socket.to(room).emit("user-left", previousId);
      }
      addMember(socket, room);
      socket.emit("reconnect-ok", { room, isOwner: rd.owner === socket.id });
      log(`🔄 ${socket.id} reconnected to ${room} (was ${previousId})`);
    });

    // --- Create Room ---
    on("create-room", (data) => {
      if (!createLimiter.take(ip)) return socket.emit("create-error", "Too many attempts. Try again in a minute.");
      if (!createPassword) return socket.emit("create-error", "Room creation is disabled on this server.");
      const room = v.normalizeRoomName(v.isPlainObject(data) ? data.room : null);
      if (!room) return socket.emit("create-error", `Room name must be 1–${v.ROOM_NAME_MAX} letters, numbers, spaces, . _ or -.`);
      if (!passwordMatches(data.password, createPassword)) return socket.emit("create-error", "Wrong password.");
      if (rooms.has(room)) return socket.emit("create-error", "Room already exists!");
      if (rooms.size >= MAX_ROOMS) return socket.emit("create-error", `Room limit reached (${MAX_ROOMS} max).`);
      rooms.set(room, { owner: socket.id, members: [], pending: new Map(), youtube: null, sharer: null });
      io.emit("update-rooms");
      socket.emit("auto-join", room);
    });

    on("list-rooms", () => socket.emit("room-list", roomList()));

    // --- Join ---
    on("join", (rawRoom) => {
      if (!joinLimiter.take(socket.id)) return socket.emit("room-error", "Too many join attempts. Slow down.");
      const room = v.normalizeRoomName(rawRoom);
      const rd = room && rooms.get(room);
      if (!rd) return socket.emit("room-error", "Room does not exist.");
      if (rd.members.includes(socket.id)) return;
      if (rd.owner === socket.id) return addMember(socket, room);
      if (rd.members.length >= MAX_MEMBERS) return socket.emit("room-full", room);
      if (!rd.pending.has(socket.id)) {
        if (socket.data.pendingRoom && socket.data.pendingRoom !== room) {
          const prev = rooms.get(socket.data.pendingRoom);
          if (prev) removePending(prev, socket.id);
        }
        const timer = setTimeout(() => {
          if (removePending(rd, socket.id)) {
            delete socket.data.pendingRoom;
            socket.emit("join-expired", room);
          }
        }, joinRequestTtlMs);
        timer.unref();
        rd.pending.set(socket.id, timer);
      }
      socket.data.pendingRoom = room;
      socket.emit("waiting-approval", room);
      io.to(rd.owner).emit("join-request", { room, userId: socket.id });
    });

    /** Resolves an owner-only action payload, or null if not allowed. */
    const ownerAction = (data) => {
      if (!v.isPlainObject(data) || !v.isSocketId(data.userId)) return null;
      const rd = rooms.get(data.room);
      if (!rd || rd.owner !== socket.id) return null;
      return { room: data.room, rd, userId: data.userId };
    };

    on("accept-user", (data) => {
      const a = ownerAction(data);
      if (!a || !removePending(a.rd, a.userId)) return;
      if (a.rd.members.length >= MAX_MEMBERS) return io.to(a.userId).emit("room-full", a.room);
      const ts = io.sockets.sockets.get(a.userId);
      if (ts) { ts.emit("join-accepted", a.room); addMember(ts, a.room); }
    });
    on("reject-user", (data) => {
      const a = ownerAction(data);
      if (!a || !removePending(a.rd, a.userId)) return;
      const ts = io.sockets.sockets.get(a.userId);
      if (ts) delete ts.data.pendingRoom;
      io.to(a.userId).emit("join-rejected", a.room);
    });
    on("kick-user", (data) => {
      const a = ownerAction(data);
      if (!a || a.userId === socket.id || !a.rd.members.includes(a.userId)) return;
      io.to(a.userId).emit("kicked", a.room);
      removeMember(a.userId, a.room);
    });

    // --- YouTube watch-together (members of the sender's room only) ---
    on("share-youtube", (data) => {
      const cur = myRoom();
      if (!cur || !v.isPlainObject(data) || !v.isYoutubeId(data.videoId)) return;
      cur.rd.youtube = { videoId: data.videoId, currentTime: 0, action: "play", updatedAt: Date.now() };
      io.to(cur.room).emit("youtube-shared", { videoId: data.videoId });
    });
    on("close-youtube", () => {
      const cur = myRoom();
      if (!cur || !cur.rd.youtube) return;
      cur.rd.youtube = null;
      io.to(cur.room).emit("youtube-closed");
    });

    // Payload: { room, action: "play"|"pause"|"seek", currentTime, sentAt }
    on("youtube-state", (data) => {
      const cur = myRoom();
      if (!cur || !v.isPlainObject(data) || !v.isYtAction(data.action) || !v.isMediaTime(data.currentTime)) return;
      const yt = cur.rd.youtube;
      if (yt) {
        yt.currentTime = data.currentTime;
        yt.updatedAt = Date.now();
        // "seek" is not a play/pause state — only update action for play/pause
        // so reconnecting users always receive a valid autoplay/pause instruction.
        if (data.action !== "seek") yt.action = data.action;
      }
      socket.to(cur.room).emit("youtube-state", {
        action: data.action,
        currentTime: data.currentTime,
        sentAt: typeof data.sentAt === "number" ? data.sentAt : Date.now(),
        from: socket.id,
      });
    });

    // Late-joiner catch-up — directed at a single roommate.
    on("youtube-state-to", (data) => {
      if (!v.isPlainObject(data) || !isRoommate(data.to)) return;
      if (!v.isYtAction(data.action) || !v.isMediaTime(data.currentTime)) return;
      io.to(data.to).emit("youtube-state-to", {
        action: data.action,
        currentTime: data.currentTime,
        sentAt: typeof data.sentAt === "number" ? data.sentAt : Date.now(),
        from: socket.id,
      });
    });

    // --- Watch Together (Screen Share signaling) ---
    // One sharer per room; tracked so viewers are notified if the sharer
    // disconnects abruptly (tab close, network loss) without an ss-stop.
    on("ss-start", () => {
      const cur = myRoom();
      if (!cur) return;
      if (cur.rd.sharer && cur.rd.sharer !== socket.id) {
        return socket.emit("ss-error", "Someone else is already sharing their screen.");
      }
      cur.rd.sharer = socket.id;
      socket.to(cur.room).emit("ss-start", { from: socket.id });
    });
    on("ss-stop", () => {
      const cur = myRoom();
      if (!cur || cur.rd.sharer !== socket.id) return;
      cur.rd.sharer = null;
      socket.to(cur.room).emit("ss-stop", { from: socket.id });
    });

    // --- Point-to-point WebRTC relays (roommates only) ---
    const relay = (event, field, isValid) =>
      on(event, (data) => {
        if (!v.isPlainObject(data) || !isRoommate(data.to) || !isValid(data[field])) return;
        io.to(data.to).emit(event, { from: socket.id, [field]: data[field] });
      });
    relay("offer", "sdp", v.isSdp);
    relay("answer", "sdp", v.isSdp);
    relay("ice-candidate", "candidate", v.isCandidate);
    relay("ss-offer", "sdp", v.isSdp);
    relay("ss-answer", "sdp", v.isSdp);
    relay("ss-ice", "candidate", v.isCandidate);

    // Toggle events go to the room by default; with `to`, only to that
    // roommate (used to catch up newly joined participants).
    const toggle = (event, outEvent, field) =>
      on(event, (data) => {
        const cur = myRoom();
        if (!cur) return;
        const payload = { id: socket.id, [field]: !!(v.isPlainObject(data) && data[field]) };
        if (v.isPlainObject(data) && data.to !== undefined) {
          if (isRoommate(data.to)) io.to(data.to).emit(outEvent, payload);
        } else {
          socket.to(cur.room).emit(outEvent, payload);
        }
      });
    toggle("toggle-video", "user-video-toggle", "hidden");
    toggle("toggle-audio", "user-audio-toggle", "muted");

    on("leave", () => removeMember(socket.id, socket.data.room));
    on("cancel-join", () => {
      clearPendingEverywhere(socket.id);
      delete socket.data.pendingRoom;
    });

    on("disconnect", () => {
      const room = socket.data.room;
      const sid = socket.id;
      clearPendingEverywhere(sid);
      // A creator who never joined their own room leaves an orphan behind.
      for (const [name, rd] of rooms) {
        if (rd.owner === sid && rd.members.length === 0) { deleteRoom(name, rd); io.emit("update-rooms"); }
      }
      // Grace period: a reconnect-session within this window swaps the new
      // socket id into the member slot, so `sid` is no longer a member here.
      if (room) {
        setTimeout(() => {
          try { removeMember(sid, room); } catch (err) { console.error("[grace] error:", err); }
        }, graceMs).unref();
      }
      log(`⚠️ ${sid} disconnected${room ? ` (${graceMs / 1000}s grace)` : ""}`);
    });
  });

  return { app, server, io, rooms, sessions };
}

module.exports = { createServer, MAX_ROOMS, MAX_MEMBERS };

if (require.main === module) {
  const { server, io } = createServer({ livereload: process.env.NODE_ENV === "development" });
  const PORT = Number(process.env.PORT) || 4000;
  server.listen(PORT, () => console.log(`🚀 Orange Meet on :${PORT}`));

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down…`);
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
