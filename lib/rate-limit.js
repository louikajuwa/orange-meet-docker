"use strict";
// Fixed-window in-memory rate limiter keyed by an arbitrary string
// (socket id, IP address, ...). Good enough for a single-process server.

class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> { count, resetAt }
  }

  /** Records a hit; returns false when the key is over its limit. */
  take(key, now = Date.now()) {
    let entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      // Opportunistic cleanup keeps the map from growing without bound.
      if (this.hits.size > 10000) this.prune(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.hits) if (now >= entry.resetAt) this.hits.delete(key);
  }
}

module.exports = { RateLimiter };
