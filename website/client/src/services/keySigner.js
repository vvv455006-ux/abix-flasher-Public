import {
  KEY_PREFIX,
  PUBLIC_KEY_SPKI,
  base64UrlToBytes,
  buildPayload,
  bytesToBase64Url,
} from "./accessKey.js";

/**
 * Operator side of the key format.
 *
 * Everything here needs the master key, which never ships in the bundle: the
 * operator pastes it into ABI ADMIN, keys are signed in the page, and the page
 * forgets the master when it is reloaded. The generated key is then checked by
 * `verifyAccessKey` anywhere, offline.
 */

async function importMaster(masterKey) {
  const der = base64UrlToBytes(String(masterKey ?? "").trim());
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
}

/** True when the pasted master key is the one this build trusts. */
export async function masterMatchesSite(
  masterKey,
  publicKeySpki = PUBLIC_KEY_SPKI,
) {
  try {
    const priv = await importMaster(masterKey);
    const jwk = await crypto.subtle.exportKey("jwk", priv);
    const pub = await crypto.subtle.importKey(
      "spki",
      base64UrlToBytes(publicKeySpki),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const site = await crypto.subtle.exportKey("jwk", pub);
    return jwk.x === site.x && jwk.y === site.y;
  } catch {
    return false;
  }
}

/**
 * Sign one access key. `days` of 0 means it never expires.
 * `credits` (1..1000) makes a v2 key: 1 credit = 1 flash. Omit it for a
 * legacy v1 key without a credit balance.
 * @returns {Promise<string>} the `ABI1.…` key
 */
export async function signAccessKey({
  masterKey,
  days = 0,
  credits,
  now = Date.now(),
  id,
} = {}) {
  const privateKey = await importMaster(masterKey);
  const payload = buildPayload({ id, days, credits, now });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      payload,
    ),
  );
  const bytes = new Uint8Array(payload.length + signature.length);
  bytes.set(payload, 0);
  bytes.set(signature, payload.length);
  return KEY_PREFIX + bytesToBase64Url(bytes);
}
