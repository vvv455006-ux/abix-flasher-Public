import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { consumeStudioCredit, getStudioCredits } from "../server/credits.js";

// File-ledger mode: no DATABASE_URL here, so the server counts credits in
// server/data/studio-credits.json (gitignored). Postgres mode uses the same
// functions against flasher_studio_credits — see server/schema.sql.
const ledgerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../server/data/studio-credits.json",
);
const hadLedgerBefore = fs.existsSync(ledgerPath);

test("1 credit = 1 flash: a 3-credit key allows exactly 3 deliveries", async (t) => {
  t.after(() => {
    // Leave no test rows behind.
    if (!hadLedgerBefore && fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
  });
  const keyId = `test-${Date.now().toString(16)}`;
  const start = await getStudioCredits(keyId, 3);
  assert.deepEqual(
    { total: start.total, used: start.used, remaining: start.remaining },
    { total: 3, used: 0, remaining: 3 },
  );

  // Probe does not spend: only getStudioCredits is called for a probe, and
  // the balance must stay untouched.
  const probed = await getStudioCredits(keyId, 3);
  assert.equal(probed.remaining, 3);

  for (const expectedRemaining of [2, 1, 0]) {
    const spent = await consumeStudioCredit(keyId, 3);
    assert.equal(spent.ok, true);
    assert.equal(spent.remaining, expectedRemaining);
  }

  // The 4th flash is refused — the last credit is already spent.
  const fourth = await consumeStudioCredit(keyId, 3);
  assert.equal(fourth.ok, false);
  assert.equal(fourth.remaining, 0);

  const end = await getStudioCredits(keyId, 3);
  assert.equal(end.used, 3);
  assert.equal(end.remaining, 0);
});

test("a legacy key without a balance is never charged", async () => {
  const keyId = `legacy-${Date.now().toString(16)}`;
  const balance = await getStudioCredits(keyId, null);
  assert.equal(balance.total, null);
  assert.equal(balance.remaining, null);
  const spent = await consumeStudioCredit(keyId, null);
  assert.equal(spent.ok, true);
});

test("concurrent spends cannot both win the last credit", async () => {
  const keyId = `race-${Date.now().toString(16)}`;
  await getStudioCredits(keyId, 1);
  const results = await Promise.all([
    consumeStudioCredit(keyId, 1),
    consumeStudioCredit(keyId, 1),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
});
