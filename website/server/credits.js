import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";

/**
 * Credit ledger for ABI1 studio keys (v2). 1 credit = 1 flash delivery.
 *
 * The total balance is signed into the key itself, so it cannot be forged.
 * How many credits are already used is tracked HERE, on the server — never
 * trusted from the client:
 *
 * - With DATABASE_URL: Postgres table `flasher_studio_credits` (see
 *   server/schema.sql). Atomic `UPDATE ... WHERE used < total`, so two
 *   concurrent flash deliveries cannot both spend the last credit.
 * - Without a database (single-server / local install): a JSON file under
 *   server/data/studio-credits.json. Same rule, synchronous read-modify-write.
 *   It is per-server, not shared across Vercel workers — that is why a
 *   database is required for a multi-instance deployment.
 *
 * v1 keys carry no balance (credits = null) and are not tracked here; they
 * are legacy keys and should be reissued as v2 keys.
 */

const FILE_PATH = path.resolve(
  import.meta.dirname,
  "data",
  "studio-credits.json",
);

function readFileLedger() {
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeFileLedger(ledger) {
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  const tmp = `${FILE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, FILE_PATH);
}

const usePostgres = () => Boolean(process.env.DATABASE_URL);

/**
 * Current balance for a key. Creates the ledger row on first sight.
 * @returns {{total:number|null, used:number, remaining:number|null, source:string}}
 */
export async function getStudioCredits(keyId, totalCredits) {
  if (totalCredits === null || totalCredits === undefined)
    return { total: null, used: 0, remaining: null, source: "legacy" };
  const total = Number(totalCredits);
  if (usePostgres()) {
    await db.query(
      `INSERT INTO flasher_studio_credits(namespace,key_id,credits_total,credits_used)
       VALUES($1,$2,$3,0)
       ON CONFLICT(namespace,key_id) DO UPDATE SET credits_total=EXCLUDED.credits_total`,
      [db.namespace, keyId, total],
    );
    const row = (
      await db.query(
        "SELECT credits_total,credits_used FROM flasher_studio_credits WHERE namespace=$1 AND key_id=$2",
        [db.namespace, keyId],
      )
    )[0];
    const used = Number(row?.credits_used ?? 0);
    return { total, used, remaining: Math.max(0, total - used), source: "postgres" };
  }
  const ledger = readFileLedger();
  const entry = ledger[keyId] ?? { total, used: 0 };
  entry.total = total;
  ledger[keyId] = entry;
  writeFileLedger(ledger);
  return {
    total,
    used: entry.used,
    remaining: Math.max(0, total - entry.used),
    source: "file",
  };
}

/**
 * Spend exactly one credit, atomically. Returns ok:false when none is left.
 * @returns {{ok:boolean, used:number, remaining:number|null, source:string}}
 */
export async function consumeStudioCredit(keyId, totalCredits) {
  if (totalCredits === null || totalCredits === undefined)
    return { ok: true, used: 0, remaining: null, source: "legacy" };
  const total = Number(totalCredits);
  if (usePostgres()) {
    await getStudioCredits(keyId, total);
    const rows = await db.query(
      `UPDATE flasher_studio_credits SET credits_used=credits_used+1
       WHERE namespace=$1 AND key_id=$2 AND credits_used < credits_total
       RETURNING credits_used`,
      [db.namespace, keyId],
    );
    if (!rows[0]) {
      const current = await getStudioCredits(keyId, total);
      return { ok: false, used: current.used, remaining: 0, source: "postgres" };
    }
    const used = Number(rows[0].credits_used);
    return { ok: true, used, remaining: Math.max(0, total - used), source: "postgres" };
  }
  const ledger = readFileLedger();
  const entry = ledger[keyId] ?? { total, used: 0 };
  entry.total = total;
  if (entry.used >= total) {
    ledger[keyId] = entry;
    writeFileLedger(ledger);
    return { ok: false, used: entry.used, remaining: 0, source: "file" };
  }
  entry.used += 1;
  entry.updatedAt = new Date().toISOString();
  ledger[keyId] = entry;
  writeFileLedger(ledger);
  return {
    ok: true,
    used: entry.used,
    remaining: Math.max(0, total - entry.used),
    source: "file",
  };
}
