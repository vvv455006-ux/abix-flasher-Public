/**
 * Offline access keys for ABI FLASHER.
 *
 * A key is `ABI1.<base64url(payload || signature)>`. The payload is signed with
 * ECDSA P-256 by the operator's master key (the Admin Key); this module only
 * ever holds the public half. That is the whole point: any device can verify a
 * key with no server, and nothing shipped in the bundle can mint a new one.
 *
 * Payload v1, 13 bytes big-endian (legacy keys, no credits):
 *   0      format version (1)
 *   1..7   6 random id bytes
 *   7..11  issued, minutes since 2024-01-01T00:00Z
 *   11..13 validity in days (0 = never expires)
 *
 * Payload v2, 15 bytes big-endian (current keys, with credits):
 *   0      format version (2)
 *   1..7   6 random id bytes
 *   7..11  issued, minutes since 2024-01-01T00:00Z
 *   11..13 validity in days (0 = never expires)
 *   13..15 credits, total (1..1000). 1 credit = 1 flash.
 *
 * Credits are part of the signed payload, so a user cannot raise their own
 * balance by editing the key. How many are already used is NOT in the key —
 * that lives on the server (authoritative when one answers) or, without a
 * server, in this device's localStorage (local only, see below).
 */

export const PUBLIC_KEY_SPKI =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYnWktIQ3In7xJhGxnTtUtE/2wrc/EArSiUtKwg/FxjDDiOKKZ3alqXV4k+cxFpdmt0Tw+N7ZmCov4CLUtUu2xA==";

export const KEY_PREFIX = "ABI1.";
export const KEY_VERSION = 1;
export const KEY_VERSION_V2 = 2;
export const PAYLOAD_BYTES = 13;
export const PAYLOAD_BYTES_V2 = 15;
export const SIGNATURE_BYTES = 64;
export const MAX_CREDITS = 1000;
export const EPOCH_MINUTE = Date.UTC(2024, 0, 1) / 60000;
export const STORAGE_KEY = "abi.flasher.access";
const USED_PREFIX = "abi.flasher.used.";

const DAY_MINUTES = 1440;
const MINUTE_MS = 60000;

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build the signed payload. `id` is 6 bytes; omitted means random.
 * Pass `credits` (1..1000) for a v2 key, omit it for a legacy v1 key.
 */
export function buildPayload({ id, days = 0, credits, now = Date.now() } = {}) {
  const isV2 = credits !== undefined && credits !== null;
  const size = isV2 ? PAYLOAD_BYTES_V2 : PAYLOAD_BYTES;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const keyId = id ?? crypto.getRandomValues(new Uint8Array(6));
  if (keyId.length !== 6) throw new Error("Access key id must be 6 bytes");
  bytes[0] = isV2 ? KEY_VERSION_V2 : KEY_VERSION;
  bytes.set(keyId, 1);
  view.setUint32(7, Math.floor(now / MINUTE_MS - EPOCH_MINUTE));
  const clampedDays = Math.max(0, Math.min(65535, Math.round(days)));
  view.setUint16(11, clampedDays);
  if (isV2) {
    if (!Number.isInteger(credits) || credits < 1 || credits > MAX_CREDITS)
      throw new Error(`Credits must be 1..${MAX_CREDITS}`);
    view.setUint16(13, credits);
  }
  return bytes;
}

/** Readable fields without verifying anything. Never trust these alone. */
export function readPayload(rawKey) {
  if (typeof rawKey !== "string" || !rawKey.trim().startsWith(KEY_PREFIX))
    return null;
  let bytes;
  try {
    bytes = base64UrlToBytes(rawKey.trim().slice(KEY_PREFIX.length));
  } catch {
    return null;
  }
  const version = bytes[0];
  const expected =
    version === KEY_VERSION
      ? PAYLOAD_BYTES + SIGNATURE_BYTES
      : version === KEY_VERSION_V2
        ? PAYLOAD_BYTES_V2 + SIGNATURE_BYTES
        : -1;
  if (bytes.length !== expected) return null;
  const payloadLength =
    version === KEY_VERSION ? PAYLOAD_BYTES : PAYLOAD_BYTES_V2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = Array.from(bytes.slice(1, 7), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const issuedAt = new Date((EPOCH_MINUTE + view.getUint32(7)) * MINUTE_MS);
  const days = view.getUint16(11);
  return {
    id,
    version,
    days,
    // v1 keys carry no credit balance: null means "legacy, unlimited".
    credits: version === KEY_VERSION_V2 ? view.getUint16(13) : null,
    issuedAt,
    expiresAt: days ? new Date(issuedAt.getTime() + days * DAY_MINUTES * MINUTE_MS) : null,
    payload: bytes.slice(0, payloadLength),
    signature: bytes.slice(payloadLength),
  };
}

let cachedPublicKey;

async function importPublicKey(spkiBase64) {
  if (spkiBase64 === PUBLIC_KEY_SPKI && cachedPublicKey) return cachedPublicKey;
  // base64UrlToBytes also accepts ordinary base64 (`+`, `/`, padding).
  const key = await crypto.subtle.importKey(
    "spki",
    base64UrlToBytes(spkiBase64),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  if (spkiBase64 === PUBLIC_KEY_SPKI) cachedPublicKey = key;
  return key;
}

/**
 * Verify against an explicit public key. Kept separate from
 * `verifyAccessKey` so tests can exercise the format with their own keypair.
 */
export async function verifyWith(publicKeySpki, rawKey, now = Date.now()) {
  const parsed = readPayload(rawKey);
  if (!parsed) return { valid: false, reason: "format", key: null };
  const key = await importPublicKey(publicKeySpki);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    parsed.signature,
    parsed.payload,
  );
  if (!ok) return { valid: false, reason: "signature", key: parsed };
  if (parsed.expiresAt && now > parsed.expiresAt.getTime())
    return { valid: false, reason: "expired", key: parsed };
  return { valid: true, reason: null, key: parsed };
}

export async function verifyAccessKey(rawKey, now = Date.now()) {
  return verifyWith(PUBLIC_KEY_SPKI, rawKey, now);
}

export function loadStoredKey() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeKey(rawKey) {
  try {
    localStorage.setItem(STORAGE_KEY, rawKey.trim());
  } catch {
    /* private mode: the session still works until reload */
  }
}

export function clearStoredKey() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Local credit counter — ONLY for installs without a server.
 *
 * The server (server/credits.js) is authoritative whenever it answers: it
 * counts every flash delivery per key id. Without a server there is nothing
 * else to count with, so this device remembers how many flashes this key
 * already did here. That counter can be reset by clearing site data, so it
 * is a convenience display, never a security boundary. Never treat a local
 * "remaining" value as proof on its own.
 */
export function getLocalUsedCredits(keyId) {
  if (!keyId) return 0;
  try {
    return Math.max(0, Number(localStorage.getItem(USED_PREFIX + keyId)) || 0);
  } catch {
    return 0;
  }
}

export function addLocalUsedCredit(keyId) {
  if (!keyId) return 0;
  const used = getLocalUsedCredits(keyId) + 1;
  try {
    localStorage.setItem(USED_PREFIX + keyId, String(used));
  } catch {
    /* private mode: the count is lost on reload */
  }
  return used;
}

/** Remaining credits from the signed total minus local use, or null (v1). */
export function getLocalRemaining(parsed) {
  if (!parsed || parsed.credits === null || parsed.credits === undefined)
    return null;
  return Math.max(0, parsed.credits - getLocalUsedCredits(parsed.id));
}
