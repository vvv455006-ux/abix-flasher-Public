import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  BLE_BOARD,
  ENC2_CMD,
  FW_DATA,
  buildNonce,
  decryptFrame,
  deriveKey,
  enc2FrameLength,
  encryptFrame,
  plainFrame,
} from "../client/src/services/enc2.js";

globalThis.crypto ??= webcrypto;

const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text) =>
  Uint8Array.from(text.match(/../g).map((pair) => parseInt(pair, 16)));

const AUTH = fromHex("00112233445566778899aabbccddeeff");
const NAME = "1EFABC12345678";
const SERIAL = NAME;

test("frames match the documented plaintext and wire sizes", async () => {
  const key = await deriveKey(NAME, AUTH);
  const pre = plainFrame(BLE_BOARD, ENC2_CMD.PRE_COMM, 0);
  assert.equal(hex(pre), "5aa500" + "3e045b00");
  assert.equal(pre.length, 7);
  assert.equal((await encryptFrame({ key, counter: 0, authParam: null, plaintext: pre })).length, 13);

  const set = plainFrame(BLE_BOARD, ENC2_CMD.SET_PWD, 0, new Uint8Array(16));
  assert.equal(set.length, 23);
  assert.equal((await encryptFrame({ key, counter: 2, authParam: AUTH, plaintext: set })).length, 29);

  const auth = plainFrame(BLE_BOARD, ENC2_CMD.AUTH, 0, new Uint8Array(14));
  assert.equal(auth.length, 21);
  assert.equal((await encryptFrame({ key, counter: 3, authParam: AUTH, plaintext: auth })).length, 27);
  assert.equal(enc2FrameLength(30), 43);
});

test("key derivation is SHA-1 over two zero-padded 16-byte keys", async () => {
  const block = new Uint8Array(16).fill(0x11);
  const a = await deriveKey("1EF", FW_DATA);
  const b = await deriveKey("1EF", FW_DATA);
  assert.equal(a.algorithm.length, 128);
  assert.equal(a.algorithm.name, "AES-CBC");
  const encrypt = (key) => crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, key, block);
  assert.equal(hex(new Uint8Array(await encrypt(a))), hex(new Uint8Array(await encrypt(b))));
  const other = await deriveKey("1CG", FW_DATA);
  assert.notEqual(hex(new Uint8Array(await encrypt(a))), hex(new Uint8Array(await encrypt(other))));
});

test("nonce carries counter, challenge and one zero byte", () => {
  const nonce = buildNonce(0x01020304, AUTH);
  assert.equal(hex(nonce), "01020304" + "0011223344556677" + "00");
});

test("a session frame round-trips and rejects a flipped ciphertext byte", async () => {
  const key = await deriveKey(NAME, AUTH);
  const plain = plainFrame(BLE_BOARD, 0x01, 0x10, [0x0e, 0x00]);
  const wire = await encryptFrame({ key, counter: 2, authParam: AUTH, plaintext: plain });
  const back = await decryptFrame({ key, authParam: AUTH, frame: wire });
  assert.equal(back.ok, true);
  assert.equal(back.counter, 2);
  assert.equal(hex(back.plaintext), hex(plain));

  const tampered = Uint8Array.from(wire);
  tampered[5] ^= 0x01;
  const bad = await decryptFrame({ key, authParam: AUTH, frame: tampered });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "mac");
});

test("a frame with the wrong challenge fails the tag instead of decoding", async () => {
  const key = await deriveKey(NAME, AUTH);
  const plain = plainFrame(BLE_BOARD, 0x08, 0x03, new Uint8Array(128));
  const wire = await encryptFrame({ key, counter: 9, authParam: AUTH, plaintext: plain });
  const wrong = await decryptFrame({
    key,
    authParam: fromHex("ffeeddccbbaa99887766554433221100"),
    frame: wire,
  });
  assert.equal(wrong.ok, false);
});

test("PRE_COMM uses the static keystream and its checksum", async () => {
  const key = await deriveKey(NAME, FW_DATA);
  const plain = plainFrame(BLE_BOARD, ENC2_CMD.PRE_COMM, 0);
  const wire = await encryptFrame({ key, counter: 0, authParam: null, plaintext: plain });
  assert.equal((wire[wire.length - 1] << 8) | wire[wire.length - 2], 0);
  const back = await decryptFrame({ key, authParam: null, frame: wire });
  assert.equal(back.ok, true);
  assert.equal(hex(back.plaintext), hex(plain));

  const broken = Uint8Array.from(wire);
  broken[5] ^= 0x01;
  const bad = await decryptFrame({ key, authParam: null, frame: broken });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "checksum");
});

test("a 30-byte PRE_COMM reply decrypts to challenge plus serial", async () => {
  const key = await deriveKey(NAME, FW_DATA);
  const payload = new Uint8Array(30);
  payload.set(AUTH, 0);
  payload.set(Uint8Array.from([...SERIAL].map((c) => c.charCodeAt(0))), 16);
  const reply = plainFrame(BLE_BOARD, ENC2_CMD.PRE_COMM, 1, payload);
  const wire = await encryptFrame({ key, counter: 0, authParam: null, plaintext: reply });
  assert.equal(wire.length, 43);
  const back = await decryptFrame({ key, authParam: null, frame: wire });
  assert.equal(back.ok, true);
  assert.equal(back.plaintext[2], 30);
  assert.equal(String.fromCharCode(...back.plaintext.subarray(23, 37)), SERIAL);
});

test("golden vector: counter 2 frame is byte stable", async () => {
  const key = await deriveKey(NAME, AUTH);
  const plain = plainFrame(
    BLE_BOARD,
    ENC2_CMD.AUTH,
    0,
    Uint8Array.from([...SERIAL].map((c) => c.charCodeAt(0))),
  );
  const wire = await encryptFrame({ key, counter: 3, authParam: AUTH, plaintext: plain });
  assert.equal(wire.length, 27);
  assert.equal(hex(wire), GOLDEN);
});

const GOLDEN = "5aa50ed12339933ff76f67a3bba12d31034277c3ef8db3ac840003";
