"use strict";
const { io: ioClient } = require("socket.io-client");
const { createServer } = require("../server");

const PASSWORD = "secret";

/** Starts a server on an ephemeral port. Call ctx.close() in an after hook. */
async function startServer(opts = {}) {
  const ctx = createServer({
    env: { NODE_ENV: "test", CREATE_PASSWORD: PASSWORD },
    graceMs: 200,
    joinRequestTtlMs: 200,
    ...opts,
  });
  await new Promise((resolve) => ctx.server.listen(0, "127.0.0.1", resolve));
  const port = ctx.server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const clients = [];

  /** Connects a websocket client and resolves once connected. */
  async function connect(clientOpts = {}) {
    const socket = ioClient(url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      ...clientOpts,
    });
    clients.push(socket);
    // Keep the latest session token so tests can use it for reconnect-session.
    socket.on("session-token", (d) => { socket.token = d.token; });
    await once(socket, "connect", 3000);
    return socket;
  }

  async function close() {
    for (const c of clients) c.disconnect();
    await new Promise((resolve) => {
      try { ctx.io.close(() => resolve()); } catch { resolve(); }
    });
    try { ctx.server.closeAllConnections?.(); } catch { /* ignore */ }
    if (ctx.server.listening) await new Promise((r) => ctx.server.close(() => r()));
  }

  return { ...ctx, ctx, port, url, connect, close, clients };
}

/** Resolves with the first event's first arg; rejects on timeout. */
function once(socket, event, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for "${event}"`));
    }, timeoutMs);
    function handler(data) {
      clearTimeout(timer);
      resolve(data);
    }
    socket.once(event, handler);
  });
}

/** Rejects if `event` arrives within `ms`. */
function expectNoEvent(socket, event, ms = 250) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
    function handler(data) {
      clearTimeout(timer);
      reject(new Error(`unexpected "${event}": ${JSON.stringify(data)}`));
    }
    socket.once(event, handler);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 1500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out");
}

/** Owner creates a room and joins it. Resolves after owner got "users". */
async function createRoom(socket, room, password = PASSWORD) {
  const auto = once(socket, "auto-join");
  socket.emit("create-room", { room, password });
  const name = await auto;
  const users = once(socket, "users");
  socket.emit("join", name);
  await users;
  await waitFor(() => socket.token);
  return name;
}

/** Guest requests to join and the owner accepts. */
async function joinAccepted(owner, guest, room) {
  const waiting = once(guest, "waiting-approval");
  const req = once(owner, "join-request");
  guest.emit("join", room);
  await waiting;
  const { userId } = await req;
  const accepted = once(guest, "join-accepted");
  const users = once(guest, "users");
  owner.emit("accept-user", { room, userId });
  await accepted;
  await users;
  await waitFor(() => guest.token);
}

/** Creates a room with owner + guest already inside. */
async function roomWithTwo(s, room = "r1") {
  const owner = await s.connect();
  const guest = await s.connect();
  await createRoom(owner, room);
  await joinAccepted(owner, guest, room);
  return { owner, guest, room };
}

const SDP = { type: "offer", sdp: "v=0" };

module.exports = {
  PASSWORD, SDP, startServer, once, expectNoEvent, sleep, waitFor,
  createRoom, joinAccepted, roomWithTwo,
};
