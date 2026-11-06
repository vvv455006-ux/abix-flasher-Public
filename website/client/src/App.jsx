import React, { Suspense, lazy, useCallback, useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  LogOut,
  Monitor,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { api } from "./services/api.js";
import { LOCAL_CATALOG } from "./data/catalog.js";
import {
  clearStoredKey,
  loadStoredKey,
  storeKey,
  verifyAccessKey,
} from "./services/accessKey.js";
import { fetchStudioCredits } from "./services/firmwareApi.js";
import DeviceCheck from "./components/DeviceCheck.jsx";
import FirmwarePanel from "./components/FirmwarePanel.jsx";
import KeyGate from "./components/KeyGate.jsx";

const Admin = lazy(() => import("./components/AdminPortal.jsx"));

export default function App() {
  // Bundled catalogue first: the page is usable the moment it renders, even
  // with no backend behind it. The API replaces it when it answers.
  const [catalog, setCatalog] = useState(LOCAL_CATALOG);
  const [admin, setAdmin] = useState(location.hash === "#admin");
  // A stored key means "check it", no key means "locked". Deciding that during
  // render keeps the effect free of synchronous state writes.
  const [access, setAccess] = useState(() =>
    loadStoredKey()
      ? { state: "checking", key: null, operator: false }
      : { state: "locked", key: null, operator: false },
  );
  // Credit balance for the active key: { total, used, remaining, localOnly }.
  // 1 credit = 1 flash. null = operator login or legacy v1 key (no balance).
  const [credits, setCredits] = useState(null);

  const refreshCredits = useCallback(async () => {
    const balance = await fetchStudioCredits();
    setCredits(balance);
    return balance;
  }, []);

  useEffect(() => {
    const lifecycle = new AbortController();
    api("/api/firmwares")
      .then((data) => {
        if (lifecycle.signal.aborted) return;
        if (data.firmwares?.length) setCatalog(data.firmwares);
      })
      .catch(() => {});
    return () => lifecycle.abort();
  }, []);

  // A returning visitor should not retype a key they already own.
  useEffect(() => {
    let alive = true;
    const stored = loadStoredKey();
    if (!stored) return undefined;
    verifyAccessKey(stored)
      .then((result) => {
        if (!alive) return;
        if (result.valid) {
          setAccess({ state: "open", key: result.key, operator: false });
          refreshCredits();
        } else {
          clearStoredKey();
          setAccess({ state: "locked", key: null, operator: false });
        }
      })
      .catch(() => {
        if (alive) setAccess({ state: "locked", key: null, operator: false });
      });
    return () => {
      alive = false;
    };
  }, [refreshCredits]);

  useEffect(() => {
    const handler = () => setAdmin(location.hash === "#admin");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const unlock = useCallback((key, operator) => {
    setAccess({ state: "open", key: key ?? null, operator });
    // Every key lands on the studio. A master key also unlocks the console,
    // which is then one header button away instead of the first thing you see.
    location.hash = "";
    setAdmin(false);
    if (key) refreshCredits();
    else setCredits(null);
  }, [refreshCredits]);

  const useGeneratedKey = useCallback(
    async (rawKey) => {
      const result = await verifyAccessKey(rawKey);
      if (!result.valid) return;
      storeKey(rawKey);
      unlock(result.key, false);
    },
    [unlock],
  );

  const signOut = useCallback(() => {
    clearStoredKey();
    setAccess({ state: "locked", key: null, operator: false });
    setCredits(null);
    setAdmin(false);
    location.hash = "";
  }, []);

  const navigateAdmin = useCallback((value) => {
    location.hash = value ? "admin" : "";
    setAdmin(value);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigateAdmin(false);
          }}
          aria-label="ABI FLASHER home"
        >
          <span className="brand-mark">
            {/* Same geometry as public/favicon.svg, drawn inline so the mark
                stays crisp and inherits the tile colour. */}
            <svg
              className="brand-glyph"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M14.2 1.6 3.4 13.4h6.3l-1.2 9 12.1-11.8h-6.4z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span>
            ABI <span className="brand-light">FLASHER</span>
            <small>by @f3Prompt</small>
          </span>
        </a>
        <span className="header-note">
          <ShieldCheck size={16} />
          {access.state === "open"
            ? access.operator
              ? "Operator access"
              : "Key active"
            : "Licensed studio"}
        </span>
        {admin && access.state === "open" && (
          <button className="button quiet small" onClick={() => navigateAdmin(false)}>
            Back to ABI FLASHER
          </button>
        )}
        {!admin && access.operator && (
          <button className="button quiet small" onClick={() => navigateAdmin(true)}>
            <KeyRound size={15} /> ABI ADMIN
          </button>
        )}
      </header>

      <main id="main-content" className="content">
        {/* The gate is the only door: even a direct #admin link lands on it. */}
        {access.state === "checking" ? (
          <p role="status" className="gate-status">
            Checking access…
          </p>
        ) : access.state === "locked" ? (
          <KeyGate onUnlock={unlock} />
        ) : admin ? (
          <Suspense fallback={<p role="status">Loading ABI ADMIN…</p>}>
            <Admin onBack={() => navigateAdmin(false)} onUseKey={useGeneratedKey} />
          </Suspense>
        ) : (
          <>
            <div className="platform-notice" role="note">
              <Monitor size={18} />
              <Smartphone size={18} />
              <p>
                <strong>Works on any device, no install.</strong> The Bluetooth
                check needs Chrome or Edge on a PC, or Chrome on Android. iOS is not supported
                for Bluetooth. Everything else runs in any browser.
              </p>
            </div>

            <section className="hero">
              <div>
                <span className="eyebrow">YOUR DISPLAY. A NEW PERSPECTIVE.</span>
                <h1>
                  A clearer way <br />
                  to flash your display<span className="accent">.</span>
                </h1>
                <p>
                  Choose the right firmware, understand every check, and see
                  exactly where your update stands.
                </p>
              </div>
              <div className="device-illustration" aria-hidden="true">
                <div className="display-face">
                  <span className="display-label">MAX G3 / DISPLAY</span>
                  <span className="display-speed">
                    00<small>km/h</small>
                  </span>
                  <div className="display-bottom">
                    <span>▰▰▰▰▱</span>
                    <span>READY</span>
                  </div>
                </div>
                <span className="illustration-caption">
                  A preview, never a hardware reading.
                </span>
              </div>
            </section>

            <DeviceCheck catalog={catalog} />

            <FirmwarePanel
              catalog={catalog}
              credits={credits}
              operator={access.operator}
              onCreditsChange={setCredits}
            />

            <div className="workspace">
              <section className="panel access-panel" aria-labelledby="access-heading">
                <span className="eyebrow">ACCESS</span>
                <h2 id="access-heading">
                  {access.operator ? "Operator access" : "Key active"}
                </h2>
                {access.key ? (
                  <dl>
                    <div>
                      <dt>Key</dt>
                      <dd data-testid="key-id">{access.key.id}</dd>
                    </div>
                    <div>
                      <dt>Credits</dt>
                      <dd data-testid="key-credits">
                        {credits
                          ? `${credits.remaining} von ${credits.total} übrig`
                          : access.key.credits !== null &&
                              access.key.credits !== undefined
                            ? `${access.key.credits} total`
                            : "Legacy-Key, ohne Credits"}
                      </dd>
                    </div>
                    <div>
                      <dt>1 Credit</dt>
                      <dd>= 1 Flash</dd>
                    </div>
                    {credits?.localOnly && (
                      <div>
                        <dt>Zähler</dt>
                        <dd>nur auf diesem Gerät</dd>
                      </div>
                    )}
                    <div>
                      <dt>Valid until</dt>
                      <dd>
                        {access.key.expiresAt
                          ? access.key.expiresAt.toLocaleDateString()
                          : "no expiry"}
                      </dd>
                    </div>
                    <div>
                      <dt>Issued</dt>
                      <dd>{access.key.issuedAt.toLocaleDateString()}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="muted">
                    Unlocked with the operator master key. Nothing is stored on
                    this device. Flashen geht nur mit einem User-Key — bitte
                    in ABI ADMIN einen Key erstellen und mit „Diesen Key
                    verwenden“ anmelden.
                  </p>
                )}
                <button className="button quiet" onClick={signOut}>
                  <LogOut size={16} /> Sign out
                </button>
              </section>

              <section className="panel note-panel">
                <span className="eyebrow">ACCESS RULES</span>
                <ul className="check-list">
                  <li>
                    <Check /> Read-only Bluetooth, never a write
                  </li>
                  <li>
                    <Check /> Images are listed only for the model they can
                    actually flash
                  </li>
                  <li>
                    <KeyRound /> One key per device, checked locally
                  </li>
                  <li>
                    <KeyRound /> 1 Credit = 1 Flash — der Credit wird beim
                    Laden des Bildes verbraucht
                  </li>
                </ul>
                <p className="caption">
                  Geschrieben wird nur nach der Checkliste und nur, wenn das
                  gelesene Modell exakt zum Bild passt. Ein übertragener Block
                  ist noch kein bestätigter Flash.
                </p>
              </section>
            </div>

            <section className="note-strip">
              <ShieldCheck size={22} />
              <div>
                <h3>Clear checks. Honest results.</h3>
                <p>
                  Unknown hardware or telemetry is refused. A delivered block is
                  not a verified flash. Nothing is called successful before final
                  verification.
                </p>
              </div>
            </section>
          </>
        )}
      </main>

      <footer>
        <span>
          ABI FLASHER <span aria-hidden="true">/</span> @f3Prompt
        </span>
        <span>G3 &amp; F3 · runs in your browser</span>
      </footer>
    </div>
  );
}
