import React, { useCallback, useState } from "react";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { clearStoredKey, storeKey, verifyAccessKey } from "../services/accessKey.js";
import { fetchStudioCredits } from "../services/firmwareApi.js";
import { masterMatchesSite } from "../services/keySigner.js";

/**
 * The door.
 *
 * A signed key is verified locally and remembered on this device. The operator
 * master key is also accepted: it is recognised by matching its public half
 * against the key this build trusts, so it opens the studio and the admin
 * console without ever being stored.
 */
export default function KeyGate({ onUnlock }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (event) => {
      event.preventDefault();
      const raw = value.trim();
      if (!raw || busy) return;
      setBusy(true);
      setError("");
      try {
        const result = await verifyAccessKey(raw);
        if (result.valid) {
          // 1 Credit = 1 Flash: a key with no credits left is refused here,
          // not only at download. The server balance wins when it answers;
          // without a server the local counter on this device decides.
          if (result.key.credits !== null && result.key.credits !== undefined) {
            storeKey(raw);
            const balance = await fetchStudioCredits();
            if (balance && balance.remaining <= 0) {
              clearStoredKey();
              setError(
                "Dieser Key hat keine Credits mehr übrig. 1 Credit = 1 Flash — bitte einen neuen Key beim Admin holen.",
              );
              return;
            }
          }
          storeKey(raw);
          onUnlock(result.key, false);
          return;
        }
        if (result.reason === "expired") {
          setError(
            `This key expired on ${result.key.expiresAt.toLocaleDateString()}.`,
          );
          return;
        }
        if (result.reason === "signature") {
          setError("That key was not issued for ABI FLASHER.");
          return;
        }
        if (await masterMatchesSite(raw)) {
          onUnlock(null, true);
          return;
        }
        setError("That is not a valid access key.");
      } catch {
        setError("Could not read that key. Check it was pasted completely.");
      } finally {
        setBusy(false);
      }
    },
    [busy, onUnlock, value],
  );

  return (
    <section className="gate" aria-labelledby="gate-heading">
      <div className="gate-card">
        <span className="brand-mark gate-mark" aria-hidden="true">
          <svg className="brand-glyph" viewBox="0 0 24 24" focusable="false">
            <path
              d="M14.2 1.6 3.4 13.4h6.3l-1.2 9 12.1-11.8h-6.4z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span className="eyebrow">ABI FLASHER</span>
        <h1 id="gate-heading">Enter your key.</h1>
        <p className="muted">
          This studio is licensed. Paste the key you received — it is checked on
          this device, no account and no upload.
        </p>
        <form onSubmit={submit} className="gate-form">
          <label htmlFor="access-key">Access key</label>
          <textarea
            id="access-key"
            name="access-key"
            rows={3}
            spellCheck="false"
            autoComplete="off"
            placeholder="ABI1.…"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            maxLength={512}
            required
          />
          <button className="button primary" disabled={busy || !value.trim()}>
            <KeyRound size={16} />
            {busy ? "Checking…" : "Unlock"}
            {!busy && <ArrowRight size={16} />}
          </button>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </form>
        <p className="caption gate-foot">
          <ShieldCheck size={14} /> Keys are issued by @f3Prompt. Never sent
          anywhere.
        </p>
      </div>
    </section>
  );
}
