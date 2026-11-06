import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const legacyPath = path.join(root, ".secrets/legacy-migration.json");
const legacy = fs.existsSync(legacyPath)
  ? JSON.parse(fs.readFileSync(legacyPath))
  : {
      adminCredential: "retired-admin-fixture",
      bearerToken: "retired-token-fixture",
    };
const fixtureCredential = crypto.randomBytes(32).toString("base64url");
const salt = crypto.randomBytes(16).toString("hex");
process.env.ADMIN_CREDENTIAL_HASH = `scrypt:${salt}:${crypto.scryptSync(fixtureCredential, salt, 64).toString("hex")}`;
process.env.SESSION_SIGNING_SECRET = crypto.randomBytes(48).toString("hex");
process.env.KEY_SIGNING_SECRET = crypto.randomBytes(48).toString("hex");
process.env.FLASHING_ENABLED = "false";
process.env.REAL_FLASHING_ENABLED = "false";
process.env.APP_NAMESPACE = "containment-test-" + process.pid;
process.env.DATA_STORE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "flasher-test-")),
  "data.json",
);
let server, base, app;
before(async () => {
  app = (await import("../server/app.js")).default;
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
});
async function request(route, body, headers = {}) {
  return fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("retired administrator credential is rejected without disclosure", async () => {
  const res = await request("/api/admin/auth", { pin: legacy.adminCredential });
  const text = await res.text();
  assert.equal(res.status, 401);
  assert.equal(text.includes(legacy.adminCredential), false);
});
test("wrong access-key shaped input never discloses the administrator credential", async () => {
  const res = await request("/api/admin/auth", {
    pin: "ABI-NOT-A-REAL-CREDENTIAL",
  });
  assert.equal(res.status, 401);
  assert.equal((await res.text()).includes(legacy.adminCredential), false);
});
test("retired fixed bearer and raw PIN cannot authenticate protected endpoints", async () => {
  for (const headers of [
    { Authorization: `Bearer ${legacy.bearerToken}` },
    { "x-admin-pin": legacy.adminCredential },
  ]) {
    const res = await request("/api/admin/stats", null, headers);
    assert.equal(res.status, 401);
  }
});
test("new administrator credential issues HttpOnly Secure session rather than fixed token", async () => {
  const res = await request("/api/admin/auth", { pin: fixtureCredential });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie") || "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal("token" in data, false);
  const stats = await request("/api/admin/stats", null, {
    Cookie: cookie.split(";")[0],
  });
  assert.equal(stats.status, 200);
  const tampered = await request("/api/admin/stats", null, {
    Cookie: cookie.split(";")[0] + "x",
  });
  assert.equal(tampered.status, 401);
});
test("cross-origin administrator authentication is forbidden", async () => {
  const res = await request(
    "/api/admin/auth",
    { pin: fixtureCredential },
    { Origin: "https://untrusted.invalid" },
  );
  assert.equal(res.status, 403);
});
test("administrator auth fails closed when server configuration is missing", async () => {
  const previous = process.env.ADMIN_CREDENTIAL_HASH;
  delete process.env.ADMIN_CREDENTIAL_HASH;
  try {
    const res = await request("/api/admin/auth", { pin: fixtureCredential });
    assert.equal(res.status, 503);
  } finally {
    process.env.ADMIN_CREDENTIAL_HASH = previous;
  }
});
test("unsafe real firmware delivery is disabled during containment", async () => {
  for (const route of [
    "/api/flasher/init-session",
    "/api/flasher/verify-and-lock",
    "/api/flasher/complete",
  ]) {
    const res = await request(route, {});
    assert.equal(res.status, 503);
  }
  const chunk = await request(
    "/api/flasher/chunk?sessionToken=invalid&chunkIndex=0",
  );
  assert.equal(chunk.status, 503);
});
test("client sources contain no retired credential or autofill functionality", () => {
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, item.name);
      if (item.isDirectory()) walk(p);
      else if (/\.(jsx?|html|css)$/.test(p)) {
        const text = fs.readFileSync(p, "utf8");
        assert.equal(
          text.includes(legacy.adminCredential),
          false,
          "credential remains in client source",
        );
        assert.equal(
          text.includes("Passcode automatisch ausfüllen"),
          false,
          "credential autofill remains",
        );
      }
    }
  }
  walk(path.join(root, "client/src"));
});
test("master key and old signing material are not source fallbacks", () => {
  const text = fs.readFileSync(path.join(root, "server/db.js"), "utf8");
  assert.equal(text.includes(legacy.adminCredential), false);
  assert.equal(text.includes("key-abi-master-admin"), false);
  assert.match(text, /process\.env\.KEY_SIGNING_SECRET/);
});
