"use strict";
// Pure input validators for socket payloads. Everything coming from a client
// is untrusted: wrong types, nulls, huge strings and prototype keys included.

const ROOM_NAME_MAX = 40;
const ROOM_NAME_RE = /^[\p{L}\p{N} _.\-]+$/u;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_MEDIA_SECONDS = 24 * 3600;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Returns the normalized room name, or null if invalid. */
function normalizeRoomName(v) {
  if (typeof v !== "string") return null;
  const name = v.trim().replace(/\s+/g, " ");
  if (!name || name.length > ROOM_NAME_MAX || !ROOM_NAME_RE.test(name)) return null;
  return name;
}

const isSocketId = (v) => typeof v === "string" && v.length > 0 && v.length <= 64;
const isYoutubeId = (v) => typeof v === "string" && YT_ID_RE.test(v);
const isMediaTime = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_MEDIA_SECONDS;
const isYtAction = (v) => v === "play" || v === "pause" || v === "seek";

/** RTCSessionDescriptionInit-shaped object. */
const isSdp = (v) => isPlainObject(v) && typeof v.type === "string" && typeof v.sdp === "string";

/** RTCIceCandidateInit-shaped object (null = end-of-candidates). */
const isCandidate = (v) => v === null || (isPlainObject(v) && typeof v.candidate === "string");

module.exports = {
  ROOM_NAME_MAX,
  isPlainObject,
  normalizeRoomName,
  isSocketId,
  isYoutubeId,
  isMediaTime,
  isYtAction,
  isSdp,
  isCandidate,
};
