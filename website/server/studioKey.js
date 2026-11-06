import crypto from "node:crypto";
import {
  EPOCH_MINUTE,
  KEY_PREFIX,
  KEY_VERSION,
  KEY_VERSION_V2,
  PAYLOAD_BYTES,
  PAYLOAD_BYTES_V2,
  PUBLIC_KEY_SPKI,
  SIGNATURE_BYTES,
} from "../client/src/services/accessKey.js";

/**
 * The studio key, checked on the server.
 *
 * The browser verifies the same signature before it renders. The server has to
 * do it again for anything it hands out: an image download must not depend on
 * a client-side gate that anyone can patch out. Only the public half lives
 * here, so this verifies keys but can never mint one.
 *
 * v1 keys (13-byte payload) carry no credits and are treated as legacy /
 * unlimited. v2 keys (15-byte payload) carry a signed total credit balance;
 * how many are used is tracked in server/credits.js, never trusted from the
 * client. 1 credit = 1 flash delivery.
 */
const publicKey = crypto.createPublicKey({
  key: Buffer.from(PUBLIC_KEY_SPKI, "base64"),
  format: "der",
  type: "spki",
});

const MINUTE_MS = 60000;

export function verifyStudioKey(rawKey, now = Date.now()) {
  const text = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!text.startsWith(KEY_PREFIX))
    return { valid: false, reason: "format", id: null, credits: null };
  const bytes = Buffer.from(text.slice(KEY_PREFIX.length), "base64url");
  const version = bytes[0];
  const payloadLength =
    version === KEY_VERSION
      ? PAYLOAD_BYTES
      : version === KEY_VERSION_V2
        ? PAYLOAD_BYTES_V2
        : -1;
  if (payloadLength < 0 || bytes.length !== payloadLength + SIGNATURE_BYTES)
    return { valid: false, reason: "format", id: null, credits: null };

  const payload = bytes.subarray(0, payloadLength);
  const signature = bytes.subarray(payloadLength);
  // WebCrypto emits raw r||s; Node needs to be told, not left to DER.
  const ok = crypto.verify(
    "sha256",
    payload,
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!ok) return { valid: false, reason: "signature", id: null, credits: null };

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const issuedAt = (EPOCH_MINUTE + view.getUint32(7)) * MINUTE_MS;
  const days = view.getUint16(11);
  if (days && now > issuedAt + days * 1440 * MINUTE_MS)
    return { valid: false, reason: "expired", id: null, credits: null };

  return {
    valid: true,
    reason: null,
    version,
    id: [...payload.subarray(1, 7)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    // v1: null = legacy key without a credit balance.
    credits: version === KEY_VERSION_V2 ? view.getUint16(13) : null,
  };
}
