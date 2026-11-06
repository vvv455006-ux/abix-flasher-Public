/**
 * Ninebot BLE "Encryption 2" (enc2) for x3 hardware (MAX G3 HW 258, F3 HW 259).
 *
 * Every frame on an x3 vehicle is encrypted after a three-phase handshake:
 *
 *   PRE_COMM  0x5B  no payload   -> 30-byte reply: auth_param[16] + serial[14]
 *   SET_PWD   0x5C  password[16] -> index 1 once the vehicle accepts it
 *   AUTH      0x5D  serial[14]   -> index 1 once the session is authenticated
 *
 * Key derivation, cipher and tag follow the public reverse engineering of
 * libnbcrypto.so (NootNooot/segway-ninebot-ble encryption.md, and the two
 * independent ports in segway-ninebot-ble-cli/nb_crypto.py and
 * ha-ninebot/crypto_v2.py). It is not an official specification and it was
 * never validated against a physical vehicle in this repository - see the note
 * in ninebotEnc2Session.js.
 *
 * Shape of one frame:
 *
 *   plaintext   5A A5 LEN | 3E TARGET CMD INDEX DATA[LEN]        LEN + 7
 *   on the wire 5A A5 LEN | CTR(3E..DATA) | tag[4] | ctr[2]      LEN + 13
 *
 * The first three bytes travel in the clear; everything from BT_ID onwards is
 * CTR-encrypted with AES-128 and authenticated with a 4-byte CBC-MAC tag that
 * is itself masked by the A_0 keystream. The trailing counter is big-endian
 * 16-bit; a counter of 0 marks the unauthenticated PRE_COMM frame, which uses
 * a static keystream and a 16-bit checksum instead.
 */

/** Fixed protocol constant from libnbcrypto.so @ 0x45A80. Device-independent. */
export const FW_DATA = Uint8Array.from([
  0x97, 0xcf, 0xb8, 0x02, 0x84, 0x41, 0x43, 0xde, 0x56, 0x00, 0x2b, 0x3b, 0x34,
  0x78, 0x0a, 0x5d,
]);

export const SYNC_BYTES = Object.freeze([0x5a, 0xa5]);
/** Protocol-layer constant carried by every frame the phone sends. */
export const BT_ID = 0x3e;
/** Handshake opcodes. */
export const ENC2_CMD = Object.freeze({
  PRE_COMM: 0x5b,
  SET_PWD: 0x5c,
  AUTH: 0x5d,
});
/** The board that runs the encryption handshake and accepts the display image. */
export const BLE_BOARD = 0x04;

export const OVERHEAD = 6; // tag (4) + counter (2)
const ZERO_16 = new Uint8Array(16);

const AES_PARAMS = { name: "AES-CBC", iv: ZERO_16 };

/**
 * One AES-128 block in ECB mode.
 *
 * WebCrypto has no ECB. A single CBC block with a zero IV is exactly ECB:
 * C = AES(P XOR 0). Callers always pass exactly 16 bytes and only need the
 * forward direction, so this stays a one-line primitive.
 */
async function ecbBlock(key, block) {
  if (block.length !== 16) throw new Error("enc2: ECB block must be 16 bytes");
  return new Uint8Array(await crypto.subtle.encrypt(AES_PARAMS, key, block));
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  // The BLE name is a string; `new Uint8Array("1EF")` is empty, which would
  // silently zero-pad every key derived from a name.
  if (typeof value === "string")
    return Uint8Array.from(value, (c) => c.charCodeAt(0) & 0xff);
  return new Uint8Array(value ?? []);
}

function pad16(value) {
  const out = new Uint8Array(16);
  out.set(toBytes(value).subarray(0, 16));
  return out;
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function xorBlock(a, b) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
  return out;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * AES key for one phase: SHA-1(pad16(key1) || pad16(key2))[0..16].
 *
 * `key2` of null is sixteen zero bytes. On Gen2 hardware PRE_COMM passes
 * FW_DATA as key2; the pwd/auth phases pass the 16-byte auth_param.
 */
export async function deriveKey(key1, key2) {
  const material = concat(pad16(key1), pad16(key2 ?? null));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", material));
  return crypto.subtle.importKey("raw", digest.subarray(0, 16), AES_PARAMS, false, [
    "encrypt",
  ]);
}

/** 13-byte nonce: BE32 counter || auth_param[0..8] || 0x00. */
export function buildNonce(counter, authParam) {
  const nonce = new Uint8Array(13);
  new DataView(nonce.buffer).setUint32(0, counter >>> 0);
  nonce.set(new Uint8Array(authParam ?? []).subarray(0, 8), 4);
  return nonce;
}

/** Plaintext frame: 5A A5 LEN 3E TARGET CMD INDEX DATA. */
export function plainFrame(target, command, index, data = []) {
  const body = Uint8Array.from(data);
  if (body.length > 255) throw new Error("enc2: payload exceeds one frame");
  if (!Number.isInteger(target) || target < 0 || target > 255)
    throw new Error("enc2: target must be a byte");
  return concat(
    Uint8Array.from([...SYNC_BYTES, body.length, BT_ID, target, command, index]),
    body,
  );
}

/** CTR keystream over the encrypted region, block counter starting at 1. */
async function ctrXor(key, data, nonce, start = 1) {
  const out = new Uint8Array(data.length);
  for (let offset = 0, block = 0; offset < data.length; offset += 16, block++) {
    const a = concat(
      Uint8Array.from([0x01]),
      nonce,
      Uint8Array.from([0x00, (start + block) & 0xff]),
    );
    const keystream = await ecbBlock(key, a);
    const chunk = Math.min(16, data.length - offset);
    for (let i = 0; i < chunk; i++) out[offset + i] = data[offset + i] ^ keystream[i];
  }
  return out;
}

/** 4-byte CBC-MAC over the three clear bytes and the encrypted region. */
async function cbcMac(key, plaintext, nonce) {
  const payload = plaintext.subarray(3);
  let x = await ecbBlock(
    key,
    concat(
      Uint8Array.from([0x59]),
      nonce,
      Uint8Array.from([0x00, payload.length & 0xff]),
    ),
  );
  const aad = new Uint8Array(16);
  aad.set(plaintext.subarray(0, 3));
  x = await ecbBlock(key, xorBlock(x, aad));
  for (let offset = 0; offset < payload.length; offset += 16) {
    const block = new Uint8Array(16);
    block.set(payload.subarray(offset, offset + 16));
    x = await ecbBlock(key, xorBlock(x, block));
  }
  return x.subarray(0, 4);
}

function checksum16(bytes) {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xffff;
  return ~sum & 0xffff;
}

/**
 * Encrypt one plaintext frame.
 *
 * `counter === 0` is the unauthenticated PRE_COMM form: a static keystream,
 * no tag, and the inverted sum in the tail. Every other value is a session
 * counter and must be strictly increasing per direction.
 */
export async function encryptFrame({ key, counter, authParam, plaintext, ecbInput }) {
  if (plaintext.length < 7) throw new Error("enc2: frame too short");
  const header = plaintext.subarray(0, 3);
  const payload = plaintext.subarray(3);

  if (counter === 0) {
    const staticKey = await ecbBlock(key, pad16(ecbInput ?? FW_DATA));
    const body = new Uint8Array(payload.length);
    for (let offset = 0; offset < payload.length; offset += 16) {
      const chunk = Math.min(16, payload.length - offset);
      for (let i = 0; i < chunk; i++) body[offset + i] = payload[offset + i] ^ staticKey[i];
    }
    const sum = checksum16(payload);
    return concat(
      header,
      body,
      Uint8Array.from([0x00, 0x00, sum & 0xff, (sum >> 8) & 0xff, 0x00, 0x00]),
    );
  }

  const nonce = buildNonce(counter, authParam);
  const tag = await cbcMac(key, plaintext, nonce);
  const body = await ctrXor(key, payload, nonce, 1);
  const a0 = await ecbBlock(
    key,
    concat(Uint8Array.from([0x01]), nonce, Uint8Array.from([0x00, 0x00])),
  );
  const maskedTag = new Uint8Array(4);
  for (let i = 0; i < 4; i++) maskedTag[i] = tag[i] ^ a0[i];
  const counterTail = new Uint8Array(2);
  new DataView(counterTail.buffer).setUint16(0, counter & 0xffff);
  return concat(header, body, maskedTag, counterTail);
}

/**
 * Decrypt one wire frame and verify it.
 *
 * @returns {{ok: boolean, plaintext: Uint8Array|null, counter: number, reason: string|null}}
 */
export async function decryptFrame({ key, authParam, frame, ecbInput }) {
  if (!(frame instanceof Uint8Array) || frame.length < 9)
    return { ok: false, plaintext: null, counter: 0, reason: "short" };
  if (frame[0] !== SYNC_BYTES[0] || frame[1] !== SYNC_BYTES[1])
    return { ok: false, plaintext: null, counter: 0, reason: "sync" };

  const header = frame.subarray(0, 3);
  const counter = (frame[frame.length - 2] << 8) | frame[frame.length - 1];
  const body = frame.subarray(3, frame.length - OVERHEAD);
  const tag = frame.subarray(frame.length - OVERHEAD, frame.length - 2);

  if (counter === 0) {
    const staticKey = await ecbBlock(key, pad16(ecbInput ?? FW_DATA));
    const plain = new Uint8Array(body.length);
    for (let offset = 0; offset < body.length; offset += 16) {
      const chunk = Math.min(16, body.length - offset);
      for (let i = 0; i < chunk; i++) plain[offset + i] = body[offset + i] ^ staticKey[i];
    }
    const expected = checksum16(plain);
    const received = tag[2] | (tag[3] << 8);
    if (expected !== received)
      return { ok: false, plaintext: null, counter, reason: "checksum" };
    return { ok: true, plaintext: concat(header, plain), counter, reason: null };
  }

  const nonce = buildNonce(counter, authParam);
  const plain = await ctrXor(key, body, nonce, 1);
  const plaintext = concat(header, plain);
  const a0 = await ecbBlock(
    key,
    concat(Uint8Array.from([0x01]), nonce, Uint8Array.from([0x00, 0x00])),
  );
  const receivedTag = new Uint8Array(4);
  for (let i = 0; i < 4; i++) receivedTag[i] = tag[i] ^ a0[i];
  const expectedTag = await cbcMac(key, plaintext, nonce);
  if (!equalBytes(receivedTag, expectedTag))
    return { ok: false, plaintext: null, counter, reason: "mac" };
  return { ok: true, plaintext, counter, reason: null };
}

/** Decode a verified plaintext frame into the shape the flash engine expects. */
export function readPlainFrame(plaintext) {
  const length = plaintext[2];
  return {
    protocol: 2,
    source: plaintext[3],
    target: plaintext[4],
    cmd: plaintext[5],
    reg: plaintext[6],
    index: plaintext[6],
    data: Uint8Array.from(plaintext.subarray(7, 7 + length)),
  };
}

/** Total wire length of an encrypted frame whose LEN byte is `length`. */
export function enc2FrameLength(length) {
  return length + 7 + OVERHEAD;
}

export { equalBytes };
