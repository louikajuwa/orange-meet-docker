"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const v = require("../lib/validate");

describe("normalizeRoomName", () => {
  test("accepts valid names", () => {
    assert.equal(v.normalizeRoomName("room-1"), "room-1");
    assert.equal(v.normalizeRoomName("Café_2.0"), "Café_2.0");
  });
  test("trims and collapses whitespace", () => {
    assert.equal(v.normalizeRoomName("  my   room \t x "), "my room x");
  });
  test("rejects empty / whitespace-only", () => {
    assert.equal(v.normalizeRoomName(""), null);
    assert.equal(v.normalizeRoomName("   "), null);
  });
  test("length limit", () => {
    assert.equal(v.normalizeRoomName("a".repeat(40)), "a".repeat(40));
    assert.equal(v.normalizeRoomName("a".repeat(41)), null);
  });
  test("rejects non-strings", () => {
    for (const x of [null, undefined, 42, {}, [], ["a"], true]) assert.equal(v.normalizeRoomName(x), null);
  });
  test("rejects markup / disallowed chars", () => {
    assert.equal(v.normalizeRoomName("<img>"), null);
    assert.equal(v.normalizeRoomName("a/b"), null);
  });
  test("__proto__ is a valid name (rooms is a Map, so harmless)", () => {
    assert.equal(v.normalizeRoomName("__proto__"), "__proto__");
    assert.equal(v.normalizeRoomName("constructor"), "constructor");
  });
});

test("isYoutubeId", () => {
  assert.equal(v.isYoutubeId("dQw4w9WgXcQ"), true);
  assert.equal(v.isYoutubeId("short"), false);
  assert.equal(v.isYoutubeId("dQw4w9WgXcQ1"), false);
  assert.equal(v.isYoutubeId("dQw4w9WgXc!"), false);
  assert.equal(v.isYoutubeId(12345678901), false);
  assert.equal(v.isYoutubeId(null), false);
});

test("isMediaTime", () => {
  assert.equal(v.isMediaTime(0), true);
  assert.equal(v.isMediaTime(12.5), true);
  assert.equal(v.isMediaTime(24 * 3600), true);
  assert.equal(v.isMediaTime(24 * 3600 + 1), false);
  assert.equal(v.isMediaTime(-1), false);
  assert.equal(v.isMediaTime(NaN), false);
  assert.equal(v.isMediaTime(Infinity), false);
  assert.equal(v.isMediaTime("5"), false);
});

test("isSdp", () => {
  assert.equal(v.isSdp({ type: "offer", sdp: "v=0" }), true);
  assert.equal(v.isSdp({ type: "offer" }), false);
  assert.equal(v.isSdp({ type: 1, sdp: "x" }), false);
  assert.equal(v.isSdp(null), false);
  assert.equal(v.isSdp([]), false);
  assert.equal(v.isSdp("v=0"), false);
});

test("isCandidate", () => {
  assert.equal(v.isCandidate({ candidate: "candidate:1" }), true);
  assert.equal(v.isCandidate(null), true); // end-of-candidates
  assert.equal(v.isCandidate({}), false);
  assert.equal(v.isCandidate({ candidate: 1 }), false);
  assert.equal(v.isCandidate("x"), false);
  assert.equal(v.isCandidate(undefined), false);
  assert.equal(v.isCandidate([]), false);
});
