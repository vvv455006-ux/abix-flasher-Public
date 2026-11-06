import test from "node:test";
import assert from "node:assert/strict";
import { masterMatchesSite, signAccessKey } from "../client/src/services/keySigner.js";
import { readPayload, verifyWith } from "../client/src/services/accessKey.js";

// A throwaway P-256 pair stands in for the operator master key, so the format
// is tested without ever touching the real one in .secrets/.
async function makePair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = Buffer.from(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).toString("base64");
  const publicKey = Buffer.from(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  ).toString("base64");
  return { privateKey, publicKey };
}

const master = await makePair();
const other = await makePair();
const day = 24 * 60 * 60 * 1000;

test("a key signed by the master verifies and carries its fields", async () => {
  const issued = Date.UTC(2026, 10, 6, 12, 0, 0);
  const key = await signAccessKey({ masterKey: master.privateKey, days: 0, now: issued });
  assert.match(key, /^ABI1\.[A-Za-z0-9_-]+$/);
  const parsed = readPayload(key);
  assert.equal(parsed.days, 0);
  assert.equal(parsed.expiresAt, null);
  assert.equal(parsed.issuedAt.getTime(), issued);
  assert.match(parsed.id, /^[0-9a-f]{12}$/);

  const result = await verifyWith(master.publicKey, key, issued + day);
  assert.equal(result.valid, true);
  assert.equal(result.key.id, parsed.id);
});

test("an expiry is enforced from the signed payload", async () => {
  const issued = Date.UTC(2026, 0, 1);
  const key = await signAccessKey({ masterKey: master.privateKey, days: 30, now: issued });
  assert.equal((await verifyWith(master.publicKey, key, issued + 29 * day)).valid, true);
  const late = await verifyWith(master.publicKey, key, issued + 31 * day);
  assert.equal(late.valid, false);
  assert.equal(late.reason, "expired");
});

test("a tampered key and a foreign key are both refused", async () => {
  const key = await signAccessKey({ masterKey: master.privateKey, days: 0 });
  const tampered =
    key.slice(0, -4) + (key.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.equal((await verifyWith(master.publicKey, tampered)).valid, false);
  const foreign = await verifyWith(other.publicKey, key);
  assert.equal(foreign.valid, false);
  assert.equal(foreign.reason, "signature");
});

test("a v2 key carries its signed credit balance (1 credit = 1 flash)", async () => {
  const issued = Date.UTC(2026, 10, 6, 12, 0, 0);
  const key = await signAccessKey({
    masterKey: master.privateKey,
    days: 30,
    credits: 5,
    now: issued,
  });
  assert.match(key, /^ABI1\.[A-Za-z0-9_-]+$/);
  const parsed = readPayload(key);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.credits, 5);
  assert.equal(parsed.days, 30);
  assert.equal(parsed.issuedAt.getTime(), issued);

  const result = await verifyWith(master.publicKey, key, issued + day);
  assert.equal(result.valid, true);
  assert.equal(result.key.credits, 5);
});

test("a v1 key still verifies and reports no credit balance", async () => {
  const key = await signAccessKey({ masterKey: master.privateKey, days: 0 });
  const parsed = readPayload(key);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.credits, null);
  assert.equal((await verifyWith(master.publicKey, key)).valid, true);
});

test("credit amounts outside 1..1000 are refused when signing", async () => {
  for (const badCredits of [0, -1, 1001, 1.5]) {
    await assert.rejects(
      signAccessKey({ masterKey: master.privateKey, credits: badCredits }),
      /Credits must be 1..1000/,
    );
  }
});

test("only the matching master key is recognised as this build's own", async () => {
  assert.equal(await masterMatchesSite(master.privateKey, master.publicKey), true);
  assert.equal(await masterMatchesSite(other.privateKey, master.publicKey), false);
  assert.equal(await masterMatchesSite("not-a-key", master.publicKey), false);
});

test("malformed input is refused without throwing", async () => {
  for (const bad of ["", "ABI1.", "ABI1.aaaa", "nonsense", "ABI2.abc"]) {
    const result = await verifyWith(master.publicKey, bad);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "format");
  }
});
