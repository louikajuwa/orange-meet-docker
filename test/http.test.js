"use strict";
const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { io: ioClient } = require("socket.io-client");
const { startServer } = require("./helpers");

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, headers: { connection: "close", ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("http", () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.close(); });

  test("GET /api/health returns ok JSON", async () => {
    const r = await get(s.port, "/api/health");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.equal(typeof j.rooms, "number");
  });

  test("SSRF proxy endpoint is gone (404)", async () => {
    const r = await get(s.port, "/api/proxy?url=" + encodeURIComponent("http://127.0.0.1"));
    assert.equal(r.status, 404);
  });

  test("security headers present on /", async () => {
    const r = await get(s.port, "/");
    assert.match(r.headers["content-security-policy"], /default-src 'self'/);
    assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["x-powered-by"], undefined);
  });

  test("polling handshake with foreign Origin is rejected", async () => {
    const r = await get(s.port, "/socket.io/?EIO=4&transport=polling", { origin: "https://evil.example" });
    assert.ok(r.status === 403 || r.status === 400, `status ${r.status}`);
  });

  test("polling handshake with same Origin is allowed", async () => {
    const r = await get(s.port, "/socket.io/?EIO=4&transport=polling", { origin: s.url });
    assert.equal(r.status, 200);
  });

  test("polling handshake with malformed Origin is rejected", async () => {
    const r = await get(s.port, "/socket.io/?EIO=4&transport=polling", { origin: "not a url" });
    assert.ok(r.status === 403 || r.status === 400, `status ${r.status}`);
  });

  test("socket.io-client with foreign Origin fails to connect", async () => {
    const sock = ioClient(s.url, {
      transports: ["polling"], forceNew: true, reconnection: false,
      extraHeaders: { origin: "https://evil.example" },
    });
    try {
      const err = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no connect_error")), 2000);
        sock.on("connect_error", (e) => { clearTimeout(t); resolve(e); });
        sock.on("connect", () => { clearTimeout(t); reject(new Error("connected!")); });
      });
      assert.ok(err);
    } finally { sock.disconnect(); }
  });

  test("socket.io-client with same Origin connects", async () => {
    const sock = ioClient(s.url, {
      transports: ["websocket"], forceNew: true, reconnection: false,
      extraHeaders: { origin: s.url },
    });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), 2000);
        sock.on("connect", () => { clearTimeout(t); resolve(); });
        sock.on("connect_error", (e) => { clearTimeout(t); reject(e); });
      });
    } finally { sock.disconnect(); }
  });
});
