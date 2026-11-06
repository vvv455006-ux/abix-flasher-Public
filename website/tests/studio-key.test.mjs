import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { verifyStudioKey } from "../server/studioKey.js";
import { signAccessKey } from "../client/src/services/keySigner.js";

globalThis.crypto ??= webcrypto;
globalThis.btoa ??= (s) => Buffer.from(s, "binary").toString("base64");
globalThis.atob ??= (s) => Buffer.from(s, "base64").toString("binary");

const master = readFileSync(new URL("../.secrets/abi-keymaster.txt", import.meta.url), "utf8")
  .split(/\s+/)
  .find((token) => /^[A-Za-z0-9_\-/+]{40,}={0,2}$/.test(token));

test("a key signed by the operator master verifies on the server", async () => {
  const key = await signAccessKey({ masterKey: master, days: 1 });
  const result = verifyStudioKey(key);
  assert.equal(result.valid, true);
  assert.equal(result.id.length, 12);
});

test("expiry, tampering and junk are refused", async () => {
  const key = await signAccessKey({ masterKey: master, days: 1 });
  const later = Date.now() + 3 * 86400000;
  assert.equal(verifyStudioKey(key, later).reason, "expired");

  const tampered = key.slice(0, -2) + (key.endsWith("AA") ? "BB" : "AA");
  assert.equal(verifyStudioKey(tampered).valid, false);
  assert.equal(verifyStudioKey("").valid, false);
  assert.equal(verifyStudioKey("ABI1.not-base64").valid, false);
  assert.equal(verifyStudioKey(null).valid, false);
});

test("a key from a foreign keypair is refused", async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const foreign = Buffer.from(pkcs8).toString("base64url");
  const key = await signAccessKey({ masterKey: foreign, days: 0 });
  assert.equal(verifyStudioKey(key).reason, "signature");
});
