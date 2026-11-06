import crypto from "node:crypto";
import { promisify } from "node:util";
import { db } from "./db.js";
const scrypt = promisify(crypto.scrypt);
const COOKIE = {
  admin: "__Host-flasher_admin",
  customer: "__Host-flasher_customer",
};
export function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try {
    const o = new URL(req.headers.origin);
    return (
      o.host === req.get("host") &&
      (o.protocol === "https:" ||
        (o.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(o.hostname)))
    );
  } catch {
    return false;
  }
}
export function cookieToken(req, role) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE[role] + "="))
    ?.slice(COOKIE[role].length + 1);
}
export function setSessionCookie(res, role, session) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE[role]}=${session.token}; Path=/; Max-Age=${session.ttl}; HttpOnly; Secure; SameSite=Strict`,
  );
}
export function clientIp(req) {
  return String(
    req.headers["x-vercel-forwarded-for"] || req.socket.remoteAddress || "",
  )
    .split(",")[0]
    .trim()
    .slice(0, 64);
}
export async function authenticateAdmin(req, res) {
  if (!sameOrigin(req))
    return res.status(403).json({ success: false, error: "Origin rejected" });
  const stored = process.env.ADMIN_CREDENTIAL_HASH;
  if (
    !stored ||
    !process.env.SESSION_SIGNING_SECRET ||
    !process.env.DATABASE_URL
  )
    return res
      .status(503)
      .json({
        success: false,
        error: "Administrator authentication unavailable",
      });
  if (!(await db.rateLimit("admin:" + clientIp(req), 10, 900)))
    return res.status(429).json({ success: false, error: "Try again later" });
  const pin = req.body?.pin;
  let valid = false;
  if (typeof pin === "string" && pin.length >= 24 && pin.length <= 256) {
    const [alg, salt, hash] = stored.split(":");
    if (
      alg === "scrypt" &&
      /^[a-f0-9]{32}$/.test(salt || "") &&
      /^[a-f0-9]{128}$/.test(hash || "")
    ) {
      const actual = await scrypt(pin, salt, 64);
      valid = crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
    }
  }
  if (!valid)
    return res
      .status(401)
      .json({ success: false, error: "Invalid administrator credential" });
  const session = await db.createSession("admin");
  setSessionCookie(res, "admin", session);
  await db.audit("admin_login");
  res.json({ success: true, expiresIn: session.ttl });
}
export function verifyRole(role) {
  return async (req, res, next) => {
    if (!sameOrigin(req))
      return res.status(403).json({ success: false, error: "Origin rejected" });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.get("x-csrf-protection") !== "1"
    )
      return res
        .status(403)
        .json({ success: false, error: "CSRF protection required" });
    const token = cookieToken(req, role);
    if (!token)
      return res
        .status(401)
        .json({ success: false, error: "Session required" });
    const session = await db.getSession(token, role);
    if (!session)
      return res.status(401).json({ success: false, error: "Session expired" });
    if (role === "customer") {
      const license = await db.getLicense(session.license_id);
      if (!license || license.status === "revoked")
        return res
          .status(401)
          .json({ success: false, error: "Access revoked" });
      req.license = license;
    }
    req.session = session;
    next();
  };
}
export const verifyAdmin = verifyRole("admin");
export async function logout(req, res, role) {
  await db.revokeSession(cookieToken(req, role));
  setSessionCookie(res, role, { token: "", ttl: 0 });
  res.json({ success: true });
}
export const realFlashingEnabled = () =>
  process.env.REAL_FLASHING_ENABLED === "true" &&
  process.env.HARDWARE_TEST_CONFIRMED === "true";
export function requireReal(req, res, next) {
  if (!realFlashingEnabled())
    return res
      .status(503)
      .json({
        success: false,
        error:
          "Real flashing is disabled until hardware qualification is confirmed. Use the isolated simulator.",
      });
  next();
}
export function verifyDeviceProof(device, proof, nonce, digest, phase) {
  if (
    !device?.qualified ||
    !proof ||
    proof.deviceId !== device.id ||
    proof.model !== device.model ||
    proof.nonce !== nonce ||
    proof.firmwareDigest !== digest ||
    proof.phase !== phase ||
    !Number.isFinite(proof.battery) ||
    proof.battery < 30 ||
    proof.battery > 100 ||
    proof.speed !== 0 ||
    typeof proof.signature !== "string" ||
    proof.signature.length > 512
  )
    return false;
  try {
    const payload = JSON.stringify({
      nonce,
      deviceId: device.id,
      model: device.model,
      battery: proof.battery,
      speed: proof.speed,
      firmwareDigest: digest,
      phase,
    });
    return crypto.verify(
      null,
      Buffer.from(payload),
      device.public_key,
      Buffer.from(proof.signature, "base64"),
    );
  } catch {
    return false;
  }
}
