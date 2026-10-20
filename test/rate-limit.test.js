"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RateLimiter } = require("../lib/rate-limit");

test("allows up to limit then blocks", () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
  assert.equal(rl.take("a", 0), true);
  assert.equal(rl.take("a", 1), true);
  assert.equal(rl.take("a", 2), true);
  assert.equal(rl.take("a", 3), false);
  assert.equal(rl.take("a", 999), false);
});

test("keys are independent", () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(rl.take("a", 0), true);
  assert.equal(rl.take("b", 0), true);
  assert.equal(rl.take("a", 1), false);
});

test("window resets", () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(rl.take("a", 0), true);
  assert.equal(rl.take("a", 500), false);
  assert.equal(rl.take("a", 1000), true);
  assert.equal(rl.take("a", 1001), false);
});

test("prune removes expired entries only", () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
  rl.take("old", 0);
  rl.take("new", 900);
  rl.prune(1000);
  assert.equal(rl.hits.has("old"), false);
  assert.equal(rl.hits.has("new"), true);
});
