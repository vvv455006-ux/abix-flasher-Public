import React, { useCallback, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  KeyRound,
  LogOut,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { readPayload } from "../services/accessKey.js";
import { masterMatchesSite, signAccessKey } from "../services/keySigner.js";

/**
 * ABI ADMIN — the only place keys are made.
 *
 * Schritt 1: Admin-Login mit dem Admin Key (= Master Key, ECDSA P-256
 * private). Der Key wird nur im Speicher dieser Seite gehalten, nie
 * gespeichert, nie an einen Server geschickt, und ist nach Reload weg.
 * Schritt 2: Key-Generator — Keys mit Credits. 1 Credit = 1 Flash.
 *
 * Die Keys sind offline signiert (ABI1 v2): Credits stehen in der signierten
 * Payload, niemand kann sie nachträglich erhöhen. Wie viele schon verbraucht
 * sind, zählt der Server (server/credits.js); ohne Server zählt das Gerät
 * lokal mit.
 */
export default function AdminPortal({ onBack, onUseKey }) {
  const [master, setMaster] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);
  const [days, setDays] = useState("0");
  const [credits, setCredits] = useState("1");
  const [count, setCount] = useState("1");
  const [keys, setKeys] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  const copy = useCallback(async (text, id) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(""), 1600);
    } catch {
      setCopied("");
    }
  }, []);

  const login = useCallback(
    async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        if (await masterMatchesSite(master)) {
          setLoggedIn(true);
        } else {
          setError("Dieser Admin Key gehört nicht zu diesem Build.");
        }
      } catch {
        setError("Admin Key konnte nicht gelesen werden.");
      } finally {
        setBusy(false);
      }
    },
    [busy, master],
  );

  const logoutAdmin = useCallback(() => {
    setMaster("");
    setLoggedIn(false);
    setKeys([]);
    setError("");
  }, []);

  const generate = useCallback(
    async (event) => {
      event.preventDefault();
      if (busy || !loggedIn) return;
      setBusy(true);
      setError("");
      setKeys([]);
      try {
        const howMany = Math.max(1, Math.min(25, Number(count) || 1));
        const life = Math.max(0, Math.min(3650, Number(days) || 0));
        const total = Math.max(1, Math.min(1000, Number(credits) || 1));
        const made = [];
        for (let i = 0; i < howMany; i++)
          made.push(
            await signAccessKey({ masterKey: master, days: life, credits: total }),
          );
        setKeys(made);
      } catch {
        setError("Keys konnten nicht erstellt werden. Admin Key prüfen.");
      } finally {
        setBusy(false);
      }
    },
    [busy, count, credits, days, loggedIn, master],
  );

  const download = useCallback(() => {
    if (!keys.length) return;
    const lines = keys.map((key) => {
      const info = readPayload(key);
      return [
        key,
        `  Credits: ${info?.credits ?? "?"} (1 Credit = 1 Flash)`,
        `  Gültig bis: ${info?.expiresAt ? info.expiresAt.toLocaleDateString("de-DE") : "unbegrenzt"}`,
        `  ID: ${info?.id ?? "?"}`,
      ].join("\n");
    });
    const blob = new Blob(
      [`ABI FLASHER Keys — ${new Date().toLocaleDateString("de-DE")}\n\n${lines.join("\n\n")}\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `abi-flasher-keys-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [keys]);

  if (!loggedIn) {
    return (
      <section className="panel admin-panel">
        <span className="eyebrow">RESTRICTED WORKSPACE</span>
        <h1>ABI ADMIN</h1>
        <p className="muted">
          Nur mit dem Admin Key. Danach kannst du Keys mit Credits erstellen —
          1 Credit = 1 Flash. Der Admin Key bleibt nur im Speicher dieser
          Seite und ist nach einem Reload weg.
        </p>
        <form className="admin-login" onSubmit={login}>
          <label htmlFor="admin-key">Admin Key</label>
          <textarea
            id="admin-key"
            name="admin-key"
            rows={4}
            spellCheck="false"
            autoComplete="off"
            placeholder="Admin Key hier einfügen"
            value={master}
            onChange={(event) => setMaster(event.target.value)}
            required
          />
          <button className="button primary" disabled={busy || !master.trim()}>
            <KeyRound size={16} />
            {busy ? "Prüfen…" : "Als Admin anmelden"}
          </button>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </form>
        <div className="admin-foot">
          <button className="button quiet" onClick={onBack} type="button">
            <ArrowLeft size={16} /> Back to ABI FLASHER
          </button>
          <span className="caption">
            <ShieldCheck size={14} /> Admin Key wird nie gespeichert oder gesendet
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel admin-panel">
      <span className="eyebrow">RESTRICTED WORKSPACE</span>
      <h1>ABI ADMIN</h1>
      <p className="muted">
        Admin angemeldet. Keys werden auf diesem Gerät mit deinem Admin Key
        signiert. <strong>1 Credit = 1 Flash.</strong> Der Admin Key ist
        nach einem Reload weg.
      </p>
      <button className="button quiet small" onClick={logoutAdmin} type="button">
        <LogOut size={14} /> Admin abmelden
      </button>

      <form className="admin-create" onSubmit={generate}>
        <div className="admin-row">
          <label htmlFor="admin-credits">
            Credits pro Key
            <input
              id="admin-credits"
              type="number"
              min="1"
              max="1000"
              value={credits}
              onChange={(event) => setCredits(event.target.value)}
            />
            <small className="caption">1 Credit = 1 Flash · 1–1000</small>
          </label>
          <label htmlFor="admin-days">
            Gültig (Tage)
            <input
              id="admin-days"
              type="number"
              min="0"
              max="3650"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            />
            <small className="caption">0 = unbegrenzt gültig</small>
          </label>
          <label htmlFor="admin-count">
            Anzahl Keys
            <input
              id="admin-count"
              type="number"
              min="1"
              max="25"
              value={count}
              onChange={(event) => setCount(event.target.value)}
            />
            <small className="caption">bis zu 25 auf einmal</small>
          </label>
        </div>
        <button className="button primary" disabled={busy}>
          <KeyRound size={16} />
          {busy ? "Signieren…" : "Keys erstellen"}
        </button>
      </form>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {keys.length > 0 && (
        <div className="key-output">
          <div className="key-output-head">
            <h2>
              {keys.length} Key{keys.length === 1 ? "" : "s"} bereit
            </h2>
            <div className="table-actions">
              <button
                className="button quiet small"
                onClick={() => copy(keys.join("\n"), "all")}
                type="button"
              >
                <Copy size={14} /> {copied === "all" ? "Kopiert" : "Alle kopieren"}
              </button>
              <button
                className="button quiet small"
                onClick={download}
                type="button"
              >
                <Download size={14} /> Als .txt laden
              </button>
            </div>
          </div>
          <ul>
            {keys.map((key) => {
              const info = readPayload(key);
              return (
                <li key={key}>
                  <code>{key}</code>
                  <span className="key-meta">
                    {info?.credits} Credit{info?.credits === 1 ? "" : "s"}
                    {" · "}
                    {info?.expiresAt
                      ? `gültig bis ${info.expiresAt.toLocaleDateString("de-DE")}`
                      : "unbegrenzt gültig"}
                    {" · ID "}
                    {info?.id}
                  </span>
                  <span className="table-actions">
                    <button
                      className="button quiet small"
                      onClick={() => copy(key, key)}
                      type="button"
                    >
                      {copied === key ? <Check size={14} /> : <Copy size={14} />}
                      {copied === key ? "Kopiert" : "Kopieren"}
                    </button>
                    {onUseKey && (
                      <button
                        className="button quiet small"
                        onClick={() => onUseKey(key)}
                        type="button"
                      >
                        <KeyRound size={14} /> Diesen Key verwenden
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="inline-notice">
        <ShieldAlert size={16} /> Admin Key nie in Screenshots, Chats oder
        den Build geben. Wer ihn hat, kann unbegrenzt Keys erstellen.
      </div>

      <div className="admin-foot">
        <button className="button quiet" onClick={onBack} type="button">
          <ArrowLeft size={16} /> Back to ABI FLASHER
        </button>
        <span className="caption">
          <ShieldCheck size={14} /> Offline signiert mit ECDSA P-256 · v2-Key mit Credits
        </span>
      </div>
    </section>
  );
}
