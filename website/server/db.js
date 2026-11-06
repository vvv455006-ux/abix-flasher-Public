import crypto from "node:crypto";
import fs from "node:fs";
import { neon } from "@neondatabase/serverless";
import { modelForFirmwareId } from "../client/src/services/ninebotModel.js";

/**
 * Firmware id -> model, from the shared registry.
 *
 * This used to be `fileId.startsWith("g3") ? "g3" : "f3"`, which turned every
 * non-`g3*` id - an uppercase legacy id, a space, a renamed bundle - into an F3
 * licence. A licence whose model is wrong hands the customer an F3 image.
 */
function modelForFirmware(fileId) {
  const model = modelForFirmwareId(fileId);
  if (!model) throw new Error(`Firmware ${fileId} is not registered to a model`);
  return model;
}
export const normalizeKey = (value) =>
  String(value || "")
    .trim()
    .startsWith("ABI2.")
    ? String(value).trim()
    : String(value || "")
        .trim()
        .toUpperCase();
export const keyHash = (value) =>
  crypto.createHash("sha256").update(normalizeKey(value)).digest("hex");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
export class Database {
  constructor(namespace) {
    this.explicitNamespace = namespace;
  }
  get namespace() {
    return (
      this.explicitNamespace ||
      process.env.APP_NAMESPACE ||
      (process.env.VERCEL_ENV === "preview" ? "preview" : "production")
    );
  }
  get sql() {
    if (!process.env.DATABASE_URL)
      throw new Error("Durable storage is not configured");
    return neon(process.env.DATABASE_URL, {
      fetchOptions: { signal: AbortSignal.timeout(15000) },
    });
  }
  async query(text, params = []) {
    return this.sql.query(text, params);
  }
  async initialize() {
    const statements = fs.readFileSync(
      new URL("./schema.sql", import.meta.url),
      "utf8",
    );
    // Migration runs out of band; this is never executed automatically for requests.
    const [tables, procedure] = statements.split("CREATE OR REPLACE FUNCTION");
    const sql = this.sql;
    await sql.transaction(
      [
        ...tables
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean),
        "CREATE OR REPLACE FUNCTION" + procedure,
      ].map((s) => sql.query(s, [])),
    );
  }
  async importLegacy(records, retiredHash) {
    let imported = 0;
    const rejected = [];
    for (const x of records) {
      const hash = keyHash(x.key);
      // No silent coercion to g3_smoke. An unregistered legacy id could have
      // been an F3 bundle, and importing it as G3 would hand that customer the
      // wrong image. The operator reviews these by hand instead.
      const file = String(x.fileId ?? "");
      if (!modelForFirmwareId(file)) {
        rejected.push({ id: x.id, fileId: x.fileId });
        continue;
      }
      const credits = Math.min(
        100000,
        Math.max(0, Number.parseInt(x.credits, 10) || 0),
      );
      const revoked =
        hash === retiredHash ||
        String(x.id).includes("master-admin") ||
        x.status === "revoked";
      const status = revoked ? "revoked" : credits > 0 ? "active" : "used";
      const meta = {
        source: "uploaded-production-snapshot",
        originalStatus: x.status,
        originalCredits: x.credits,
        legacyUid: x.lockedUid || null,
        legacySerial: x.lockedSerial || null,
        requiresBindingReview: !!x.lockedUid,
      };
      const result = await this.query(
        `INSERT INTO flasher_licenses(namespace,id,key_hash,key_hint,file_id,model,customer,credits,status,locked_device,legacy_meta)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
        [
          this.namespace,
          x.id,
          hash,
          "…" + String(x.key).slice(-4),
          file,
          modelForFirmware(file),
          String(x.customerName || "").slice(0, 120),
          credits,
          status,
          x.lockedUid || null,
          JSON.stringify(meta),
        ],
      );
      imported += result.length;
    }
    return {
      imported,
      rejected,
      total: Number(
        (
          await this.query(
            "SELECT count(*)::int AS count FROM flasher_licenses WHERE namespace=$1",
            [this.namespace],
          )
        )[0].count,
      ),
    };
  }
  async createKey({ fileId, customerName = "", credits = 1 }) {
    if (
      !modelForFirmwareId(fileId) ||
      !Number.isInteger(credits) ||
      credits < 1 ||
      credits > 1000
    )
      throw new Error("Invalid licence parameters");
    const secret = process.env.KEY_SIGNING_SECRET;
    if (!secret || secret.length < 64)
      throw new Error("Signing service unavailable");
    const payload = crypto.randomBytes(24).toString("base64url");
    const key = `ABI2.${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("hex").slice(0, 32)}`;
    const id = crypto.randomUUID();
    await this.query(
      `INSERT INTO flasher_licenses(namespace,id,key_hash,key_hint,file_id,model,customer,credits,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
      [
        this.namespace,
        id,
        keyHash(key),
        "…" + key.slice(-4),
        fileId,
        modelForFirmware(fileId),
        String(customerName).slice(0, 120),
        credits,
      ],
    );
    await this.audit("key_created", id, { credits, fileId });
    return { key, license: await this.getLicense(id) };
  }
  async lookupKey(raw) {
    if (typeof raw !== "string" || raw.length > 256 || raw.length < 8)
      return null;
    const key = normalizeKey(raw);
    if (key.startsWith("ABI2.")) {
      const secret = process.env.KEY_SIGNING_SECRET;
      const parts = key.split(".");
      if (
        !secret ||
        parts.length !== 3 ||
        !/^[A-Za-z0-9_-]{32}$/.test(parts[1]) ||
        !/^[a-f0-9]{32}$/.test(parts[2])
      )
        return null;
      const expected = crypto
        .createHmac("sha256", secret)
        .update(parts[1])
        .digest("hex")
        .slice(0, 32);
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2])))
        return null;
    }
    return (
      (
        await this.query(
          "SELECT * FROM flasher_licenses WHERE namespace=$1 AND key_hash=$2",
          [this.namespace, keyHash(key)],
        )
      )[0] || null
    );
  }
  async getLicense(id) {
    return (
      (
        await this.query(
          "SELECT * FROM flasher_licenses WHERE namespace=$1 AND id=$2",
          [this.namespace, id],
        )
      )[0] || null
    );
  }
  async getKeys() {
    return this.query(
      "SELECT id,key_hint,file_id,model,customer,credits,status,locked_device,created_at FROM flasher_licenses WHERE namespace=$1 ORDER BY created_at DESC",
      [this.namespace],
    );
  }
  async updateLicense(id, action) {
    const query =
      action === "add-credit"
        ? `UPDATE flasher_licenses SET credits=credits+1,status=CASE WHEN status='used' THEN 'active' ELSE status END WHERE namespace=$1 AND id=$2 AND credits<100000 RETURNING id`
        : action === "unlock"
          ? `UPDATE flasher_licenses SET locked_device=NULL WHERE namespace=$1 AND id=$2 RETURNING id`
          : action === "revoke"
            ? `UPDATE flasher_licenses SET status='revoked' WHERE namespace=$1 AND id=$2 RETURNING id`
            : null;
    if (!query) throw new Error("Invalid operation");
    const result = await this.query(query, [this.namespace, id]);
    await this.audit(action, id);
    return result.length > 0;
  }
  sessionHash(token) {
    const secret = process.env.SESSION_SIGNING_SECRET;
    if (!secret || secret.length < 64)
      throw new Error("Session service unavailable");
    return crypto.createHmac("sha256", secret).update(token).digest("hex");
  }
  async createSession(role, licenseId = null) {
    const token = crypto.randomBytes(32).toString("base64url");
    const ttl = role === "admin" ? 900 : 3600;
    await this.query(
      `INSERT INTO flasher_sessions(namespace,token_hash,role,license_id,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 second')`,
      [this.namespace, this.sessionHash(token), role, licenseId, ttl],
    );
    return { token, ttl };
  }
  async getSession(token, role) {
    if (!token || token.length > 128) return null;
    return (
      (
        await this.query(
          "SELECT * FROM flasher_sessions WHERE namespace=$1 AND token_hash=$2 AND role=$3 AND expires_at>now()",
          [this.namespace, this.sessionHash(token), role],
        )
      )[0] || null
    );
  }
  async revokeSession(token) {
    if (token)
      await this.query(
        "UPDATE flasher_sessions SET expires_at=now() WHERE namespace=$1 AND token_hash=$2",
        [this.namespace, this.sessionHash(token)],
      );
  }
  async rateLimit(bucket, limit = 10, seconds = 900) {
    const window = Math.floor(Date.now() / 1000 / seconds);
    const row = (
      await this.query(
        `INSERT INTO flasher_limits(namespace,bucket,window_id,count,expires_at) VALUES($1,$2,$3,1,now()+$4*interval '1 second') ON CONFLICT(namespace,bucket,window_id) DO UPDATE SET count=flasher_limits.count+1 RETURNING count`,
        [this.namespace, digest(bucket), window, seconds],
      )
    )[0];
    return Number(row.count) <= limit;
  }
  async audit(action, entityId = null, details = {}) {
    await this.query(
      "INSERT INTO flasher_audit(namespace,action,entity_id,details) VALUES($1,$2,$3,$4)",
      [this.namespace, action, entityId, JSON.stringify(details)],
    );
  }
  async getLogs() {
    return this.query(
      "SELECT action,entity_id,details,created_at FROM flasher_audit WHERE namespace=$1 ORDER BY created_at DESC LIMIT 100",
      [this.namespace],
    );
  }
  async createAttempt(licenseId, fileId, deviceId, requestId, digest) {
    const id = crypto.randomUUID(),
      nonce = crypto.randomBytes(24).toString("hex");
    const rows = await this.query(
      `INSERT INTO flasher_attempts(namespace,id,license_id,request_id,file_id,device_id,nonce,digest)
   SELECT $1,$2,id,$3,$4,$5,$6,$7 FROM flasher_licenses WHERE namespace=$1 AND id=$8 AND file_id=$4 AND status='active' AND credits>0 AND (locked_device IS NULL OR locked_device=$5)
   ON CONFLICT(namespace,license_id,request_id) DO NOTHING RETURNING *`,
      [
        this.namespace,
        id,
        requestId,
        fileId,
        deviceId,
        nonce,
        digest,
        licenseId,
      ],
    );
    if (rows[0]) return rows[0];
    const prior = (
      await this.query(
        "SELECT * FROM flasher_attempts WHERE namespace=$1 AND license_id=$2 AND request_id=$3 AND file_id=$4 AND device_id=$5 AND expires_at>now()",
        [this.namespace, licenseId, requestId, fileId, deviceId],
      )
    )[0];
    return prior || null;
  }
  async getAttempt(id, licenseId) {
    return (
      (
        await this.query(
          "SELECT * FROM flasher_attempts WHERE namespace=$1 AND id=$2 AND license_id=$3 AND expires_at>now()",
          [this.namespace, id, licenseId],
        )
      )[0] || null
    );
  }
  async chargeDelivery(id) {
    return (
      await this.query("SELECT flasher_charge_delivery($1,$2) AS allowed", [
        this.namespace,
        id,
      ])
    )[0].allowed;
  }
  async confirmAttempt(id) {
    return (
      (
        await this.query(
          `UPDATE flasher_attempts SET status='confirmed' WHERE namespace=$1 AND id=$2 AND charged=true RETURNING id`,
          [this.namespace, id],
        )
      ).length > 0
    );
  }
  async createChallenge(licenseId) {
    const id = crypto.randomUUID(),
      nonce = crypto.randomBytes(32).toString("hex");
    await this.query(
      "INSERT INTO flasher_challenges(namespace,id,license_id,nonce) VALUES($1,$2,$3,$4)",
      [this.namespace, id, licenseId, nonce],
    );
    return { id, nonce };
  }
  async consumeChallenge(id, licenseId) {
    return (
      (
        await this.query(
          "UPDATE flasher_challenges SET used=true WHERE namespace=$1 AND id=$2 AND license_id=$3 AND used=false AND expires_at>now() RETURNING nonce",
          [this.namespace, id, licenseId],
        )
      )[0] || null
    );
  }
  async getDevice(id) {
    return (
      (
        await this.query(
          "SELECT * FROM flasher_devices WHERE namespace=$1 AND id=$2 AND qualified=true",
          [this.namespace, id],
        )
      )[0] || null
    );
  }
}
export const db = new Database();
export const publicLicense = (x) =>
  x && {
    id: x.id,
    hint: x.key_hint,
    fileId: x.file_id,
    model: x.model,
    credits: x.credits,
    status: x.status,
    isBound: !!x.locked_device,
  };
