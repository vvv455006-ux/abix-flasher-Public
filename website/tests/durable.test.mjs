import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Database, keyHash } from "../server/db.js";
import { verifyDeviceProof } from "../server/security.js";
process.env.KEY_SIGNING_SECRET = crypto.randomBytes(48).toString("hex");
process.env.SESSION_SIGNING_SECRET = crypto.randomBytes(48).toString("hex");
const db = new Database("integration-" + crypto.randomUUID());
const fresh = () =>
  db.createKey({
    fileId: "g3_blackwave",
    customerName: "Automated fixture",
    credits: 1,
  });
const digest = "a".repeat(64);

test("durable licences survive a fresh Database object and keys are hash-only", async () => {
  const { key, license } = await fresh();
  const reloaded = await new Database(db.namespace).lookupKey(key);
  assert.equal(reloaded.id, license.id);
  assert.equal("key" in reloaded, false);
  assert.equal(reloaded.key_hash, keyHash(key));
  assert.equal(await db.lookupKey(key + "x"), null);
});
test("parallel delivery attempts cannot spend a single credit twice", async () => {
  const { license } = await fresh();
  const attempts = await Promise.all(
    [0, 1].map(() =>
      db.createAttempt(
        license.id,
        "g3_blackwave",
        "fixture-device",
        crypto.randomUUID(),
        digest,
      ),
    ),
  );
  const results = await Promise.all(
    attempts.map((a) => db.chargeDelivery(a.id)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await db.getLicense(license.id)).credits, 0);
});
test("delivery retries are idempotent across workers", async () => {
  const { license } = await fresh();
  const a = await db.createAttempt(
    license.id,
    "g3_blackwave",
    "fixture-device",
    crypto.randomUUID(),
    digest,
  );
  assert.equal(await db.chargeDelivery(a.id), true);
  assert.equal(await new Database(db.namespace).chargeDelivery(a.id), true);
  const ledger = await db.query(
    "SELECT count(*)::int AS n FROM flasher_ledger WHERE namespace=$1 AND attempt_id=$2",
    [db.namespace, a.id],
  );
  assert.equal(ledger[0].n, 1);
  assert.equal((await db.getLicense(license.id)).credits, 0);
});
test("wrong firmware entitlement and mismatched binding are rejected", async () => {
  const { license } = await fresh();
  assert.equal(
    await db.createAttempt(
      license.id,
      "f3_smoke",
      "fixture",
      crypto.randomUUID(),
      digest,
    ),
    null,
  );
  const a = await db.createAttempt(
    license.id,
    "g3_blackwave",
    "device-a",
    crypto.randomUUID(),
    digest,
  );
  await db.chargeDelivery(a.id);
  await db.updateLicense(license.id, "add-credit");
  assert.equal(
    await db.createAttempt(
      license.id,
      "g3_blackwave",
      "device-b",
      crypto.randomUUID(),
      digest,
    ),
    null,
  );
});
test("revocation survives new objects and prevents redelivery", async () => {
  const { key, license } = await fresh();
  const a = await db.createAttempt(
    license.id,
    "g3_blackwave",
    "fixture",
    crypto.randomUUID(),
    digest,
  );
  await db.chargeDelivery(a.id);
  await db.updateLicense(license.id, "revoke");
  assert.equal(
    (await new Database(db.namespace).lookupKey(key)).status,
    "revoked",
  );
  assert.equal(await db.chargeDelivery(a.id), false);
});
test("sessions are durable and revocable; limits are shared across workers", async () => {
  const s = await db.createSession("admin");
  assert.equal(
    (await new Database(db.namespace).getSession(s.token, "admin")).role,
    "admin",
  );
  await db.revokeSession(s.token);
  assert.equal(await db.getSession(s.token, "admin"), null);
  const bucket = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      new Database(db.namespace).rateLimit(bucket, 3, 900),
    ),
  );
  assert.equal(results.filter(Boolean).length, 3);
});
test("all 28 preserved records migrate idempotently and retired master is revoked", async () => {
  const legacy = JSON.parse(
    fs.readFileSync(
      new URL("../.secrets/legacy-migration.json", import.meta.url),
    ),
  );
  const isolated = new Database("migration-" + crypto.randomUUID());
  const first = await isolated.importLegacy(
    legacy.datastore.keys,
    keyHash(legacy.adminCredential),
  );
  assert.equal(first.total, 28);
  const second = await isolated.importLegacy(
    legacy.datastore.keys,
    keyHash(legacy.adminCredential),
  );
  assert.equal(second.imported, 0);
  assert.equal(second.total, 28);
  assert.equal(
    (await isolated.lookupKey(legacy.adminCredential)).status,
    "revoked",
  );
});
test("server device verification requires a qualified enrolled signer and exact model/nonce/digest", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const device = {
    id: "fixture",
    model: "g3",
    qualified: true,
    public_key: publicKey.export({ type: "spki", format: "pem" }),
  };
  const payload = {
    nonce: "nonce",
    deviceId: "fixture",
    model: "g3",
    battery: 90,
    speed: 0,
    firmwareDigest: digest,
    phase: "identify",
  };
  const proof = {
    ...payload,
    signature: crypto
      .sign(null, Buffer.from(JSON.stringify(payload)), privateKey)
      .toString("base64"),
  };
  assert.equal(
    verifyDeviceProof(device, proof, "nonce", digest, "identify"),
    true,
  );
  for (const bad of [
    { ...proof, model: "f3" },
    { ...proof, battery: null },
    { ...proof, speed: 1 },
    { ...proof, nonce: "replay" },
  ])
    assert.equal(
      verifyDeviceProof(device, bad, "nonce", digest, "identify"),
      false,
    );
  assert.equal(
    verifyDeviceProof(
      { ...device, qualified: false },
      proof,
      "nonce",
      digest,
      "identify",
    ),
    false,
  );
});
