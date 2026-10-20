"use strict";
const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  PASSWORD, SDP, startServer, once, expectNoEvent, sleep,
  createRoom, joinAccepted, roomWithTwo,
} = require("./helpers");

let s;
beforeEach(async () => { s = await startServer(); });
afterEach(async () => { await s.close(); });

describe("create-room", () => {
  test("wrong password -> create-error", async () => {
    const c = await s.connect();
    const e = once(c, "create-error");
    c.emit("create-room", { room: "x", password: "nope" });
    assert.match(await e, /Wrong password/);
    assert.equal(s.rooms.size, 0);
  });

  test("missing / non-object payloads -> create-error, server alive", async () => {
    const c = await s.connect();
    for (const payload of [undefined, null, 42, "x", []]) {
      const e = once(c, "create-error");
      c.emit("create-room", payload);
      await e;
    }
    const l = once(c, "room-list");
    c.emit("list-rooms");
    assert.deepEqual(await l, []);
  });

  test("invalid names -> create-error", async () => {
    const c = await s.connect();
    for (const room of ["", " ", "a".repeat(41), "<img>"]) {
      const e = once(c, "create-error");
      c.emit("create-room", { room, password: PASSWORD });
      assert.match(await e, /Room name must be/, JSON.stringify(room));
    }
    assert.equal(s.rooms.size, 0);
  });

  test('"constructor" works as a normal room', async () => {
    const owner = await s.connect();
    const guest = await s.connect();
    await createRoom(owner, "constructor");
    assert.ok(s.rooms.has("constructor"));
    await joinAccepted(owner, guest, "constructor");
    assert.equal(s.rooms.get("constructor").members.length, 2);
  });

  test("name is normalized", async () => {
    const c = await s.connect();
    const a = once(c, "auto-join");
    c.emit("create-room", { room: "  my   room ", password: PASSWORD });
    assert.equal(await a, "my room");
  });

  test("duplicate -> error", async () => {
    const a = await s.connect();
    const b = await s.connect();
    await createRoom(a, "dup");
    const e = once(b, "create-error");
    b.emit("create-room", { room: "dup", password: PASSWORD });
    assert.match(await e, /already exists/);
  });

  test("MAX_ROOMS (10) limit", async () => {
    for (let i = 0; i < 10; i++) {
      s.rooms.set(`pre${i}`, { owner: "x", members: [], pending: new Map(), youtube: null, sharer: null });
    }
    const c = await s.connect();
    const e = once(c, "create-error");
    c.emit("create-room", { room: "eleventh", password: PASSWORD });
    assert.match(await e, /Room limit reached/);
    assert.equal(s.rooms.has("eleventh"), false);
  });

  test("per-IP rate limit: 11th attempt -> Too many attempts", async () => {
    const c = await s.connect();
    for (let i = 0; i < 10; i++) {
      const e = once(c, "create-error");
      c.emit("create-room", { room: "x", password: "bad" });
      assert.match(await e, /Wrong password/);
    }
    const e = once(c, "create-error");
    c.emit("create-room", { room: "x", password: PASSWORD });
    assert.match(await e, /Too many attempts/);
    assert.equal(s.rooms.size, 0);
  });

  test("rate limit is per IP, shared across sockets", async () => {
    const a = await s.connect();
    for (let i = 0; i < 10; i++) {
      const e = once(a, "create-error");
      a.emit("create-room", { room: "x", password: "bad" });
      await e;
    }
    const b = await s.connect();
    const e = once(b, "create-error");
    b.emit("create-room", { room: "x", password: PASSWORD });
    assert.match(await e, /Too many attempts/);
  });

  test("production without CREATE_PASSWORD -> disabled", async () => {
    const prod = await startServer({ env: { NODE_ENV: "production" } });
    try {
      const c = await prod.connect();
      const e = once(c, "create-error");
      c.emit("create-room", { room: "x", password: "anything" });
      assert.match(await e, /disabled/);
      assert.equal(prod.rooms.size, 0);
    } finally { await prod.close(); }
  });
});

describe("list-rooms", () => {
  test("room-list includes name, count, max", async () => {
    const owner = await s.connect();
    await createRoom(owner, "lobby");
    const c = await s.connect();
    const l = once(c, "room-list");
    c.emit("list-rooms");
    assert.deepEqual(await l, [{ name: "lobby", count: 1, max: 2 }]);
  });
});

describe("join flow", () => {
  test("owner create + join gets users []", async () => {
    const owner = await s.connect();
    const auto = once(owner, "auto-join");
    owner.emit("create-room", { room: "r", password: PASSWORD });
    assert.equal(await auto, "r");
    const users = once(owner, "users");
    owner.emit("join", "r");
    assert.deepEqual(await users, []);
    assert.deepEqual(s.rooms.get("r").members, [owner.id]);
  });

  test("guest -> waiting-approval, owner join-request, accept", async () => {
    const owner = await s.connect();
    const guest = await s.connect();
    await createRoom(owner, "r");
    const waiting = once(guest, "waiting-approval");
    const req = once(owner, "join-request");
    guest.emit("join", "r");
    assert.equal(await waiting, "r");
    const r = await req;
    assert.deepEqual(r, { room: "r", userId: guest.id });
    const acc = once(guest, "join-accepted");
    const users = once(guest, "users");
    const joined = once(owner, "user-joined");
    owner.emit("accept-user", { room: "r", userId: guest.id });
    assert.equal(await acc, "r");
    assert.deepEqual(await users, [owner.id]);
    assert.equal(await joined, guest.id);
    assert.deepEqual(s.rooms.get("r").members, [owner.id, guest.id]);
  });

  test("reject -> join-rejected, not a member", async () => {
    const owner = await s.connect();
    const guest = await s.connect();
    await createRoom(owner, "r");
    const req = once(owner, "join-request");
    guest.emit("join", "r");
    await req;
    const rej = once(guest, "join-rejected");
    owner.emit("reject-user", { room: "r", userId: guest.id });
    assert.equal(await rej, "r");
    assert.deepEqual(s.rooms.get("r").members, [owner.id]);
  });

  test("non-owner accept / kick ignored", async () => {
    const owner = await s.connect();
    const guest = await s.connect();
    await createRoom(owner, "r");
    await joinAccepted(owner, guest, "r");
    guest.emit("kick-user", { room: "r", userId: owner.id });
    await expectNoEvent(owner, "kicked");
    assert.deepEqual(s.rooms.get("r").members, [owner.id, guest.id]);
    assert.equal(s.rooms.get("r").owner, owner.id);
  });

  test("non-owner accept of a pending user is ignored", async () => {
    const owner = await s.connect();
    const guest = await s.connect();
    const other = await s.connect();
    await createRoom(owner, "r");
    const req = once(owner, "join-request");
    guest.emit("join", "r");
    await req;
    other.emit("accept-user", { room: "r", userId: guest.id });
    await expectNoEvent(guest, "join-accepted");
    assert.deepEqual(s.rooms.get("r").members, [owner.id]);
  });

  test("accept of a socket id that is not pending is ignored", async () => {
    const owner = await s.connect();
    const outsider = await s.connect();
    await createRoom(owner, "r");
    owner.emit("accept-user", { room: "r", userId: outsider.id });
    owner.emit("accept-user", { room: "r", userId: "bogus" });
    await expectNoEvent(outsider, "join-accepted");
    await expectNoEvent(outsider, "users");
    assert.deepEqual(s.rooms.get("r").members, [owner.id]);
  });

  test("room full -> room-full for 3rd user", async () => {
    const { owner } = await roomWithTwo(s, "r");
    const third = await s.connect();
    const full = once(third, "room-full");
    third.emit("join", "r");
    assert.equal(await full, "r");
    await expectNoEvent(owner, "join-request");
  });

  test("join-expired after TTL, then accept is ignored", async () => {
    const owner = await s.connect();
    const guest = await s.connect();
    await createRoom(owner, "r");
    const req = once(owner, "join-request");
    guest.emit("join", "r");
    await req;
    assert.equal(await once(guest, "join-expired", 2000), "r");
    owner.emit("accept-user", { room: "r", userId: guest.id });
    await expectNoEvent(guest, "join-accepted");
  });

  test("cancel-join clears pending", async () => {
    const owner = await s.connect();
    const guest = await s.connect();
    await createRoom(owner, "r");
    const req = once(owner, "join-request");
    guest.emit("join", "r");
    await req;
    guest.emit("cancel-join");
    await sleep(50);
    assert.equal(s.rooms.get("r").pending.size, 0);
    await expectNoEvent(guest, "join-expired", 400);
  });

  test("join of nonexistent room -> room-error, server alive", async () => {
    const c = await s.connect();
    for (const name of ["nope", "constructor", "__proto__", "toString", null, 5]) {
      const e = once(c, "room-error");
      c.emit("join", name);
      assert.match(await e, /does not exist/);
    }
    const l = once(c, "room-list");
    c.emit("list-rooms");
    await l;
  });
});

describe("kick / leave / reconnect", () => {
  test("kicked user gets kicked; their token no longer reconnects", async () => {
    const { owner, guest, room } = await roomWithTwo(s);
    const token = guest.token;
    const kicked = once(guest, "kicked");
    owner.emit("kick-user", { room, userId: guest.id });
    assert.equal(await kicked, room);
    const c2 = await s.connect();
    const f = once(c2, "reconnect-failed");
    c2.emit("reconnect-session", { token, room });
    await f;
    assert.deepEqual(s.rooms.get(room).members, [owner.id]);
  });

  test("leave revokes token", async () => {
    const { guest, room } = await roomWithTwo(s);
    const token = guest.token;
    guest.emit("leave");
    await sleep(50);
    const c2 = await s.connect();
    const f = once(c2, "reconnect-failed");
    c2.emit("reconnect-session", { token, room });
    await f;
    assert.equal(s.sessions.has(token), false);
  });

  test("reconnect within grace takes the member slot", async () => {
    const { owner, guest, room } = await roomWithTwo(s);
    const oldId = guest.id;
    const token = guest.token;
    guest.disconnect();
    const c2 = await s.connect();
    const left = once(owner, "user-left");
    const ok = once(c2, "reconnect-ok");
    c2.emit("reconnect-session", { token, room });
    assert.deepEqual(await ok, { room, isOwner: false });
    assert.equal(await left, oldId);
    const rd = s.rooms.get(room);
    assert.ok(rd.members.includes(c2.id));
    assert.ok(!rd.members.includes(oldId));
    assert.equal(rd.members.length, 2);
    // survives past the grace timer of the old socket
    await sleep(400);
    assert.ok(s.rooms.get(room).members.includes(c2.id));
    assert.equal(s.rooms.get(room).members.length, 2);
  });

  test("reconnect with wrong room or bad token fails", async () => {
    const { guest, room } = await roomWithTwo(s);
    const c2 = await s.connect();
    for (const payload of [{ token: guest.token, room: "other" }, { token: "zzz", room }, { room }]) {
      const f = once(c2, "reconnect-failed");
      c2.emit("reconnect-session", payload);
      await f;
    }
  });

  test("owner reconnect transfers ownership", async () => {
    const { owner, guest, room } = await roomWithTwo(s);
    const token = owner.token;
    owner.disconnect();
    const c2 = await s.connect();
    const ok = once(c2, "reconnect-ok");
    c2.emit("reconnect-session", { token, room });
    assert.deepEqual(await ok, { room, isOwner: true });
    const rd = s.rooms.get(room);
    assert.equal(rd.owner, c2.id);
    assert.ok(rd.members.includes(guest.id));
  });

  test("after grace expiry member is removed and others get user-left", async () => {
    const { owner, guest, room } = await roomWithTwo(s);
    const gid = guest.id;
    const left = once(owner, "user-left", 1500);
    guest.disconnect();
    assert.equal(await left, gid);
    assert.deepEqual(s.rooms.get(room).members, [owner.id]);
  });

  test("owner leaves while guest remains -> guest promoted", async () => {
    const { owner, guest } = await roomWithTwo(s);
    const ml = once(guest, "member-list");
    owner.emit("leave");
    const list = await ml;
    assert.equal(list.ownerId, guest.id);
    assert.deepEqual(list.members, [{ id: guest.id, isOwner: true }]);
  });

  test("owner disconnect (after grace) promotes guest", async () => {
    const { owner, guest } = await roomWithTwo(s);
    const ml = once(guest, "member-list", 1500);
    owner.disconnect();
    assert.equal((await ml).ownerId, guest.id);
  });

  test("room deleted when last member leaves", async () => {
    const owner = await s.connect();
    await createRoom(owner, "solo");
    owner.emit("leave");
    await sleep(50);
    assert.equal(s.rooms.has("solo"), false);
  });

  test("orphan room (creator never joined) is deleted on disconnect", async () => {
    const owner = await s.connect();
    const a = once(owner, "auto-join");
    owner.emit("create-room", { room: "orphan", password: PASSWORD });
    await a;
    assert.ok(s.rooms.has("orphan"));
    owner.disconnect();
    await sleep(100);
    assert.equal(s.rooms.has("orphan"), false);
  });
});

describe("relay authorization", () => {
  async function twoRooms() {
    const { owner: a1, guest: a2 } = await roomWithTwo(s, "A");
    const b1 = await s.connect();
    await createRoom(b1, "B");
    const nobody = await s.connect();
    return { a1, a2, b1, nobody };
  }

  test("outsiders and other-room members cannot relay to a member", async () => {
    const { a2, b1, nobody } = await twoRooms();
    const ytTo = { to: a2.id, action: "play", currentTime: 1 };
    for (const sender of [b1, nobody]) {
      sender.emit("offer", { to: a2.id, sdp: SDP });
      sender.emit("answer", { to: a2.id, sdp: SDP });
      sender.emit("ice-candidate", { to: a2.id, candidate: { candidate: "c" } });
      sender.emit("ss-offer", { to: a2.id, sdp: SDP });
      sender.emit("ss-answer", { to: a2.id, sdp: SDP });
      sender.emit("ss-ice", { to: a2.id, candidate: { candidate: "c" } });
      sender.emit("youtube-state-to", ytTo);
      sender.emit("toggle-video", { to: a2.id, hidden: true });
      sender.emit("toggle-audio", { to: a2.id, muted: true });
    }
    await Promise.all(
      ["offer", "answer", "ice-candidate", "ss-offer", "ss-answer", "ss-ice",
        "youtube-state-to", "user-video-toggle", "user-audio-toggle"].map((e) => expectNoEvent(a2, e)),
    );
  });

  test("roommates receive relays with {from, ...}", async () => {
    const { owner, guest } = await roomWithTwo(s, "A");
    const cand = { candidate: "candidate:1" };
    const o = once(guest, "offer");
    owner.emit("offer", { to: guest.id, sdp: SDP });
    assert.deepEqual(await o, { from: owner.id, sdp: SDP });

    const a = once(owner, "answer");
    guest.emit("answer", { to: owner.id, sdp: { type: "answer", sdp: "v=0" } });
    assert.deepEqual(await a, { from: guest.id, sdp: { type: "answer", sdp: "v=0" } });

    const i = once(guest, "ice-candidate");
    owner.emit("ice-candidate", { to: guest.id, candidate: cand });
    assert.deepEqual(await i, { from: owner.id, candidate: cand });

    const so = once(guest, "ss-offer");
    owner.emit("ss-offer", { to: guest.id, sdp: SDP });
    assert.deepEqual(await so, { from: owner.id, sdp: SDP });

    const y = once(guest, "youtube-state-to");
    owner.emit("youtube-state-to", { to: guest.id, action: "pause", currentTime: 5, sentAt: 7 });
    assert.deepEqual(await y, { from: owner.id, action: "pause", currentTime: 5, sentAt: 7 });

    const t = once(guest, "user-video-toggle");
    owner.emit("toggle-video", { to: guest.id, hidden: true });
    assert.deepEqual(await t, { id: owner.id, hidden: true });
  });

  test("invalid relay payloads and self-relay are dropped", async () => {
    const { owner, guest } = await roomWithTwo(s, "A");
    owner.emit("offer", { to: guest.id, sdp: "string" });
    owner.emit("offer", { to: guest.id });
    owner.emit("ice-candidate", { to: guest.id, candidate: 5 });
    owner.emit("offer", { to: owner.id, sdp: SDP });
    await Promise.all([
      expectNoEvent(guest, "offer"), expectNoEvent(guest, "ice-candidate"), expectNoEvent(owner, "offer"),
    ]);
  });

  test("toggle without `to` goes to roommates only", async () => {
    const { owner, guest } = await roomWithTwo(s, "A");
    const b1 = await s.connect();
    await createRoom(b1, "B");
    const t = once(guest, "user-audio-toggle");
    owner.emit("toggle-audio", { muted: true });
    assert.deepEqual(await t, { id: owner.id, muted: true });
    await expectNoEvent(b1, "user-audio-toggle");
  });
});

describe("youtube", () => {
  test("share-youtube from non-member ignored", async () => {
    const { owner, guest } = await roomWithTwo(s);
    const outsider = await s.connect();
    outsider.emit("share-youtube", { videoId: "dQw4w9WgXcQ" });
    await Promise.all([expectNoEvent(owner, "youtube-shared"), expectNoEvent(guest, "youtube-shared")]);
  });

  test("invalid videoId ignored", async () => {
    const { owner, guest } = await roomWithTwo(s);
    for (const videoId of ["short", "<script>alert1", 12345678901, null, undefined]) {
      owner.emit("share-youtube", { videoId });
    }
    await Promise.all([expectNoEvent(owner, "youtube-shared"), expectNoEvent(guest, "youtube-shared")]);
  });

  test("valid id is shared to the room", async () => {
    const { owner, guest } = await roomWithTwo(s);
    const a = once(owner, "youtube-shared");
    const b = once(guest, "youtube-shared");
    owner.emit("share-youtube", { videoId: "dQw4w9WgXcQ" });
    assert.deepEqual(await a, { videoId: "dQw4w9WgXcQ" });
    assert.deepEqual(await b, { videoId: "dQw4w9WgXcQ" });
  });

  test("youtube-state relayed to roommate; close-youtube closes", async () => {
    const { owner, guest } = await roomWithTwo(s);
    owner.emit("share-youtube", { videoId: "dQw4w9WgXcQ" });
    await once(guest, "youtube-shared");
    const st = once(guest, "youtube-state");
    owner.emit("youtube-state", { action: "seek", currentTime: 30, sentAt: 1 });
    assert.deepEqual(await st, { action: "seek", currentTime: 30, sentAt: 1, from: owner.id });
    const closed = once(guest, "youtube-closed");
    owner.emit("close-youtube");
    await closed;
  });

  test("late joiner is told the current video", async () => {
    const owner = await s.connect();
    const guest = await s.connect();
    await createRoom(owner, "r");
    owner.emit("share-youtube", { videoId: "dQw4w9WgXcQ" });
    await once(owner, "youtube-shared");
    const yt = once(guest, "youtube-shared");
    await joinAccepted(owner, guest, "r");
    const got = await yt;
    assert.equal(got.videoId, "dQw4w9WgXcQ");
    assert.equal(got.action, "play");
  });
});

describe("screen share", () => {
  test("ss-start notifies roommate; second sharer gets ss-error", async () => {
    const { owner, guest } = await roomWithTwo(s);
    const st = once(guest, "ss-start");
    owner.emit("ss-start");
    assert.deepEqual(await st, { from: owner.id });
    const err = once(guest, "ss-error");
    guest.emit("ss-start");
    assert.match(await err, /already sharing/);
    await expectNoEvent(owner, "ss-start");
  });

  test("ss-stop from non-sharer is not relayed; from sharer is", async () => {
    const { owner, guest } = await roomWithTwo(s);
    owner.emit("ss-start");
    await once(guest, "ss-start");
    guest.emit("ss-stop");
    await expectNoEvent(owner, "ss-stop");
    const stop = once(guest, "ss-stop");
    owner.emit("ss-stop");
    assert.deepEqual(await stop, { from: owner.id });
  });

  test("sharer leaving notifies the room with ss-stop", async () => {
    const { owner, guest } = await roomWithTwo(s);
    owner.emit("ss-start");
    await once(guest, "ss-start");
    const stop = once(guest, "ss-stop");
    owner.emit("leave");
    await stop;
  });
});

describe("robustness", () => {
  const EVENTS = [
    "reconnect-session", "create-room", "list-rooms", "join", "accept-user", "reject-user",
    "kick-user", "share-youtube", "close-youtube", "youtube-state", "youtube-state-to",
    "ss-start", "ss-stop", "ss-offer", "ss-answer", "ss-ice", "toggle-video", "toggle-audio",
    "offer", "answer", "ice-candidate", "leave", "cancel-join",
  ];
  const PAYLOADS = [null, undefined, 42, "x", [], {}];

  async function blast(sock) {
    for (const ev of EVENTS) for (const p of PAYLOADS) sock.emit(ev, p);
  }

  test("garbage payloads on every event never break the server", async (t) => {
    const errSpy = t.mock.method(console, "error", () => {});
    const { owner, guest } = await roomWithTwo(s, "r");
    const outsider = await s.connect();
    // Throwaway ids so create-room rate limit etc. don't matter.
    await blast(outsider);
    await blast(guest);
    await blast(owner);
    await sleep(150);
    assert.equal(errSpy.mock.callCount(), 0, "a handler threw: " + JSON.stringify(errSpy.mock.calls.map((c) => String(c.arguments[1]))));

    const fresh = await s.connect();
    const l = once(fresh, "room-list");
    fresh.emit("list-rooms");
    assert.ok(Array.isArray(await l));
    const res = await fetch(`${s.url}/api/health`, { headers: { connection: "close" } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});
