import express from "express";
import fs from "node:fs";
import path from "node:path";
import { db, publicLicense } from "./db.js";
import {
  authenticateAdmin,
  verifyAdmin,
  verifyRole,
  sameOrigin,
  cookieToken,
  setSessionCookie,
  logout,
  clientIp,
  requireReal,
  realFlashingEnabled,
  verifyDeviceProof,
} from "./security.js";
import { getCatalog, firmwareBytes, firmwareFor } from "./firmware_service.js";
import { verifyStudioKey } from "./studioKey.js";
import { consumeStudioCredit, getStudioCredits } from "./credits.js";
import { modelForFirmwareId } from "../client/src/services/ninebotModel.js";
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb", strict: true }));
app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  if (!sameOrigin(req))
    return res.status(403).json({ success: false, error: "Origin rejected" });
  next();
});
const customer = verifyRole("customer");
const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const bad = (res, message, status = 400) =>
  res.status(status).json({ success: false, error: message });
app.get("/api/health", (req, res) =>
  res.json({
    success: true,
    release: "abi-flasher-1",
    realFlashingEnabled: realFlashingEnabled(),
    storage: "postgres",
    simulator: "isolated-browser",
  }),
);
app.get("/api/firmwares", (req, res) =>
  res.json({ success: true, firmwares: getCatalog() }),
);
/**
 * Credit balance for the studio key in `x-abi-key`.
 * v1 keys answer with total null (legacy, no balance). The server is
 * authoritative: the client never reports its own remaining balance.
 */
app.get("/api/studio/credits", async (req, res) => {
  const key = verifyStudioKey(req.get("x-abi-key"));
  if (!key.valid)
    return res.status(401).json({
      success: false,
      error:
        key.reason === "expired"
          ? "Access key expired"
          : "A valid access key is required",
    });
  try {
    const balance = await getStudioCredits(key.id, key.credits);
    return res.json({ success: true, credits: balance });
  } catch {
    return bad(res, "Credit check unavailable", 503);
  }
});
/**
 * The image itself, only with a studio key the server can verify.
 *
 * The gate in the browser is convenience; this is the door. A key that is
 * missing, forged, expired or minted for another build gets no bytes.
 *
 * Credits — 1 credit = 1 flash:
 * - `?mode=probe` ("Bild prüfen"): checks the balance but spends nothing.
 *   Still needs at least 1 credit left, because the full image is delivered.
 * - `?mode=flash` (default, the real flash): spends exactly 1 credit
 *   atomically BEFORE the bytes are sent. A delivery is a delivery, even if
 *   the Bluetooth transfer afterwards fails — same rule as the licence
 *   system in README ("charged at first authorized delivery").
 * v1 keys have no balance and are not charged (legacy).
 */
app.get("/api/studio/image/:id", async (req, res) => {
  const key = verifyStudioKey(req.get("x-abi-key"));
  if (!key.valid)
    return res.status(401).json({
      success: false,
      error:
        key.reason === "expired"
          ? "Access key expired"
          : "A valid access key is required",
    });
  const firmware = firmwareFor(req.params.id);
  if (!firmware) return bad(res, "Unknown image", 404);
  const mode = req.query.mode === "probe" ? "probe" : "flash";
  let balance = null;
  if (key.credits !== null && key.credits !== undefined) {
    try {
      balance = await getStudioCredits(key.id, key.credits);
      if (balance.remaining <= 0)
        return bad(
          res,
          "Keine Credits übrig. 1 Credit = 1 Flash — bitte einen neuen Key beim Admin holen.",
          403,
        );
      if (mode === "flash") {
        const spent = await consumeStudioCredit(key.id, key.credits);
        if (!spent.ok)
          return bad(
            res,
            "Keine Credits übrig. 1 Credit = 1 Flash — bitte einen neuen Key beim Admin holen.",
            403,
          );
        balance = spent;
      }
    } catch {
      return bad(res, "Credit check unavailable", 503);
    }
  }
  const bytes = firmwareBytes(firmware.id);
  res.set({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes.length),
    "X-Firmware-SHA256": firmware.sha256,
    "Cache-Control": "private, max-age=300",
    ...(balance
      ? {
          "X-Credits-Total": String(balance.total),
          "X-Credits-Used": String(balance.used),
          "X-Credits-Remaining": String(balance.remaining),
        }
      : {}),
  });
  res.send(bytes);
});
app.post("/api/admin/auth", authenticateAdmin);
app.get("/api/admin/session", verifyAdmin, (req, res) =>
  res.json({ success: true }),
);
app.post("/api/admin/logout", verifyAdmin, (req, res) =>
  logout(req, res, "admin"),
);
app.get("/api/admin/keys", verifyAdmin, async (req, res) =>
  res.json({ success: true, keys: await db.getKeys() }),
);
app.get("/api/admin/logs", verifyAdmin, async (req, res) =>
  res.json({ success: true, logs: await db.getLogs() }),
);
app.get("/api/admin/stats", verifyAdmin, async (req, res) => {
  const keys = await db.getKeys();
  res.json({
    success: true,
    stats: {
      totalKeys: keys.length,
      activeKeys: keys.filter((x) => x.status === "active").length,
      credits: keys
        .filter((x) => x.status !== "revoked")
        .reduce((s, x) => s + x.credits, 0),
    },
  });
});
app.post("/api/admin/keys/generate", verifyAdmin, async (req, res) => {
  if (!(await db.rateLimit("admin-mint:" + req.session.token_hash, 30, 900)))
    return bad(res, "Try again later", 429);
  const { fileId, customerName, credits } = req.body || {};
  if (
    typeof fileId !== "string" ||
    !getCatalog().some((x) => x.id === fileId) ||
    typeof customerName !== "string" ||
    customerName.length > 120 ||
    !Number.isInteger(credits) ||
    credits < 1 ||
    credits > 1000
  )
    return bad(res, "Invalid licence parameters");
  res.json({
    success: true,
    ...(await db.createKey({ fileId, customerName, credits })),
  });
});
app.post("/api/admin/keys/:id/:action", verifyAdmin, async (req, res) => {
  if (
    !["add-credit", "unlock", "revoke"].includes(req.params.action) ||
    req.params.id.length > 128
  )
    return bad(res, "Invalid operation");
  res
    .status(
      (await db.updateLicense(req.params.id, req.params.action)) ? 200 : 404,
    )
    .json({ success: true });
});
app.post("/api/flasher/login-key", async (req, res) => {
  if (!(await db.rateLimit("login:" + clientIp(req), 20, 900)))
    return bad(res, "Try again later", 429);
  const key = req.body?.key;
  if (typeof key !== "string" || key.length > 256)
    return bad(res, "Invalid access key", 401);
  const license = await db.lookupKey(key);
  if (!license || license.status === "revoked" || license.credits <= 0)
    return bad(res, "Invalid, revoked or exhausted access key", 401);
  const session = await db.createSession("customer", license.id);
  setSessionCookie(res, "customer", session);
  res.json({ success: true, license: publicLicense(license) });
});
app.get("/api/flasher/me", customer, (req, res) =>
  res.json({ success: true, license: publicLicense(req.license) }),
);
app.post("/api/flasher/logout", customer, (req, res) =>
  logout(req, res, "customer"),
);
// Gate every delivery/identity endpoint before authentication. No simulator traffic reaches these routes.
app.use(
  [
    "/api/flasher/challenge",
    "/api/flasher/init-session",
    "/api/flasher/verify-and-lock",
    "/api/flasher/chunk",
    "/api/flasher/package",
    "/api/flasher/complete",
  ],
  requireReal,
);
app.post("/api/flasher/challenge", customer, async (req, res) => {
  if (!(await db.rateLimit("challenge:" + req.license.id, 10, 900)))
    return bad(res, "Try again later", 429);
  res.json({ success: true, ...(await db.createChallenge(req.license.id)) });
});
app.post("/api/flasher/init-session", customer, async (req, res) => {
  const { selectedFileId, deviceProof, challengeId, requestId } =
    req.body || {};
  if (
    !uuid(challengeId) ||
    !uuid(requestId) ||
    selectedFileId !== req.license.file_id ||
    !deviceProof ||
    typeof deviceProof.deviceId !== "string" ||
    deviceProof.deviceId.length > 128
  )
    return bad(res, "Invalid or unentitled firmware/device");
  const firmware = firmwareFor(selectedFileId);
  // A licence row whose stored model disagrees with the registered model of
  // its firmware is corrupt - surface it instead of flashing it.
  if (
    !firmware ||
    firmware.model !== req.license.model ||
    modelForFirmwareId(req.license.file_id) !== req.license.model
  )
    return bad(res, "Licence model record is inconsistent; review required", 409);
  const device = await db.getDevice(deviceProof.deviceId);
  if (!device || device.model !== firmware.model)
    return bad(res, "Exact qualified hardware match required", 403);
  const challenge = await db.consumeChallenge(challengeId, req.license.id);
  if (
    !challenge ||
    !verifyDeviceProof(
      device,
      deviceProof,
      challenge.nonce,
      firmware.sha256,
      "identify",
    )
  )
    return bad(res, "Server-verifiable device evidence required", 403);
  const attempt = await db.createAttempt(
    req.license.id,
    firmware.id,
    device.id,
    requestId,
    firmware.sha256,
  );
  if (!attempt)
    return bad(res, "No available entitlement or device binding mismatch", 403);
  res.json({
    success: true,
    attempt: { id: attempt.id, nonce: attempt.nonce, firmware },
  });
});
app.get("/api/flasher/package/:id", customer, async (req, res) => {
  if (!uuid(req.params.id)) return bad(res, "Invalid attempt");
  const a = await db.getAttempt(req.params.id, req.license.id);
  if (!a) return bad(res, "Attempt unavailable", 403);
  if (!(await db.chargeDelivery(a.id)))
    return bad(res, "Delivery authorization denied", 403);
  const bytes = firmwareBytes(a.file_id);
  res.set({
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes.length),
    "X-Firmware-SHA256": a.digest,
  });
  res.send(bytes);
});
app.post("/api/flasher/complete", customer, async (req, res) => {
  const { attemptId, deviceProof } = req.body || {};
  if (!uuid(attemptId) || !deviceProof) return bad(res, "Invalid completion");
  const a = await db.getAttempt(attemptId, req.license.id);
  if (!a || !a.charged) return bad(res, "No delivered attempt", 403);
  const device = await db.getDevice(a.device_id);
  if (!verifyDeviceProof(device, deviceProof, a.nonce, a.digest, "complete"))
    return bad(res, "Verified device digest required", 403);
  await db.confirmAttempt(a.id);
  res.json({
    success: true,
    license: publicLicense(await db.getLicense(req.license.id)),
  });
});
app.use("/api", (req, res) => bad(res, "Endpoint not found", 404));
const dist = path.resolve(import.meta.dirname, "../client/dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res) => res.sendFile(path.join(dist, "index.html")));
}
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.type === "entity.parse.failed") return bad(res, "Invalid JSON");
  res
    .status(503)
    .json({
      success: false,
      error: "Service temporarily unavailable; no success has been confirmed",
    });
});
export default app;
