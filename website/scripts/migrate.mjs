import fs from "node:fs";
import { Database, keyHash } from "../server/db.js";
try {
  const legacy = JSON.parse(
    fs.readFileSync(
      new URL("../.secrets/legacy-migration.json", import.meta.url),
    ),
  );
  const first = new Database("production");
  await first.initialize();
  for (const ns of ["production", "preview"]) {
    const result = await new Database(ns).importLegacy(
      legacy.datastore.keys,
      keyHash(legacy.adminCredential),
    );
    if (result.total !== 28) throw new Error("Unexpected migration count");
    console.log(
      JSON.stringify({ namespace: ns, ...result, retiredMasterRevoked: true }),
    );
  }
} catch (e) {
  console.error("Migration failed:", e.code || "migration_error");
  process.exitCode = 1;
}
