import {
  addLocalUsedCredit,
  getLocalRemaining,
  loadStoredKey,
  readPayload,
} from "./accessKey.js";

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function creditsFromHeaders(response) {
  const remaining = response.headers.get("x-credits-remaining");
  if (remaining === null) return null;
  return {
    total: Number(response.headers.get("x-credits-total")),
    used: Number(response.headers.get("x-credits-used")),
    remaining: Number(remaining),
    localOnly: false,
  };
}

/**
 * Server-side credit balance for the stored key, or the local fallback.
 * Returns null when there is no key or no balance to report (operator login,
 * legacy v1 key). `localOnly` is true when no server answered and the count
 * comes from this device only — see accessKey.js for why that is not proof.
 */
export async function fetchStudioCredits() {
  const key = loadStoredKey();
  if (!key) return null;
  const parsed = readPayload(key);
  if (!parsed) return null;
  try {
    const response = await fetch("/api/studio/credits", {
      headers: { "x-abi-key": key },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.credits) return { ...data.credits, localOnly: false };
    }
  } catch {
    /* no server — fall through to the local counter */
  }
  if (parsed.credits === null) return null;
  return {
    total: parsed.credits,
    used: parsed.credits - (getLocalRemaining(parsed) ?? parsed.credits),
    remaining: getLocalRemaining(parsed),
    localOnly: true,
  };
}

/**
 * Download one image with the studio key and check it against the digest the
 * catalogue published. A mismatch is a delivery problem, not a flash decision:
 * the bytes are refused before the engine ever sees them.
 *
 * Credits — 1 credit = 1 flash:
 * - `forFlash: true` (the real flash): the server spends 1 credit when the
 *   image is delivered. The returned `credits` carry the new balance.
 * - `forFlash: false` ("Bild prüfen"): spends nothing, but still needs at
 *   least 1 credit left, because the full image is delivered.
 * Without a server, a successful flash download counts 1 credit locally on
 * this device (see accessKey.js).
 */
export async function fetchFirmwareImage(firmware, { signal, forFlash = true } = {}) {
  const key = loadStoredKey();
  if (!key)
    throw new Error("Kein Key gespeichert. Erst entsperren, dann laden.");
  const mode = forFlash ? "flash" : "probe";
  const response = await fetch(`/api/studio/image/${firmware.id}?mode=${mode}`, {
    headers: { "x-abi-key": key },
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error ?? `Bild konnte nicht geladen werden (${response.status}).`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await sha256Hex(bytes);
  const expected = firmware.sha256 ?? response.headers.get("x-firmware-sha256");
  if (expected && digest !== expected)
    throw new Error("Bild-Digest stimmt nicht mit dem Katalog überein.");
  let credits = creditsFromHeaders(response);
  if (!credits && forFlash) {
    // No server answered with a balance: count the delivery locally.
    const parsed = readPayload(key);
    if (parsed?.credits !== null && parsed?.credits !== undefined) {
      addLocalUsedCredit(parsed.id);
      credits = {
        total: parsed.credits,
        used: parsed.credits - (getLocalRemaining(parsed) ?? 0),
        remaining: getLocalRemaining(parsed),
        localOnly: true,
      };
    }
  }
  return { bytes, sha256: digest, credits };
}
