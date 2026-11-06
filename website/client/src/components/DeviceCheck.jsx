import React, { useCallback, useMemo, useState } from "react";
import {
  Bluetooth,
  Check,
  CircleHelp,
  Copy,
  Info,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { NinebotBleService, bleService } from "../services/ninebotBleService.js";
import { identifyDevice } from "../services/ninebotModel.js";

/**
 * Public front door: connect, read, decide. No licence, no writes.
 *
 * Everything here is safe for a first-time visitor. The model verdict is
 * evidence-based - two independent readings or nothing - so the page can say
 * "I do not know" instead of guessing a model. That guess is what used to hand
 * people the wrong firmware.
 */

const STATUS_COPY = {
  verified: {
    title: "Model confirmed",
    tone: "ok",
    body: "Two independent readings agree. Only now is a firmware image tied to this scooter.",
  },
  provisional: {
    title: "One reading only",
    tone: "warn",
    body: "Enough to identify the family, not enough to choose a firmware image. Add a second reading below.",
  },
  conflict: {
    title: "Readings disagree",
    tone: "bad",
    body: "Two sources point at different models. Do not flash, and do not \"fix\" the serial to make it match.",
  },
  unknown: {
    title: "Unknown hardware",
    tone: "bad",
    body: "No model evidence was found. That is a result, not a failure - nothing is guessed here.",
  },
  foreign: {
    title: "Different x3 model",
    tone: "bad",
    body: "This is an x3-family vehicle, but not a G3 or F3. No image in this catalogue fits it.",
  },
};

function Fact({ label, value, hint }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>
        {value}
        {hint && <small>{hint}</small>}
      </dd>
    </div>
  );
}

export default function DeviceCheck({ catalog = [] }) {
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [advertisement, setAdvertisement] = useState(null);
  const [connection, setConnection] = useState(null);
  const [serial, setSerial] = useState("");
  const [banner, setBanner] = useState("");
  const [copied, setCopied] = useState(false);
  // Stamped at connect time: a report should say when the reading happened,
  // not when the panel re-rendered.
  const [checkedAt, setCheckedAt] = useState(null);

  const supported = NinebotBleService.isWebBluetoothSupported();

  const identity = useMemo(
    () =>
      identifyDevice({
        hardwareId: advertisement?.hardwareId ?? undefined,
        serial: serial.trim() || undefined,
        vcuBanner: banner.trim() || undefined,
        bleName: advertisement?.name ?? undefined,
      }),
    [advertisement, serial, banner],
  );

  const connect = useCallback(async () => {
    setPhase("connecting");
    setError("");
    try {
      await bleService.connectReadOnly({ acceptAllDevices: true });
      const facts = await bleService.readAdvertisement({ timeoutMs: 6000 });
      setAdvertisement(facts);
      setCheckedAt(new Date().toISOString());
      setConnection({
        name: facts.name ?? bleService.device?.name ?? null,
        gattProfile: bleService.profileKind,
        writeMode: bleService.writeMode,
        readOnly: bleService.readOnly,
      });
      setPhase("connected");
    } catch (e) {
      setError(e.message);
      setPhase("error");
    }
  }, []);

  const disconnect = useCallback(async () => {
    await bleService.disconnect();
    setConnection(null);
    setAdvertisement(null);
    setPhase("idle");
  }, []);

  const report = useMemo(
    () =>
      JSON.stringify(
        {
          checkedAt,
          connection,
          advertisement,
          readings: { serial: serial || null, vcuBanner: banner || null },
          identity,
        },
        null,
        2,
      ),
    [checkedAt, connection, advertisement, serial, banner, identity],
  );

  const copyReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [report]);

  const copy = STATUS_COPY[identity.status] ?? STATUS_COPY.unknown;
  const firmware = catalog.filter((f) => f.model === identity.model);

  return (
    <section className="panel device-check" aria-labelledby="check-heading">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">FREE · NO ACCESS KEY</span>
          <h2 id="check-heading">Check your scooter</h2>
        </div>
        <span className="tag">
          <ShieldCheck size={14} /> Read-only
        </span>
      </div>

      <p className="muted">
        Connect over Bluetooth and this page reads what the scooter broadcasts.
        It never writes a byte, never asks for a licence and never guesses a
        model. If it cannot prove the model, it says so.
      </p>

      {!supported && (
        <div className="inline-notice warn" role="note">
          <TriangleAlert size={18} />
          <p>
            This browser has no Web Bluetooth. Use desktop Chrome or Edge, or
            Chrome on Android. iOS cannot do this at all.
          </p>
        </div>
      )}

      <div className="check-actions">
        {phase !== "connected" ? (
          <button
            className="button primary"
            onClick={connect}
            disabled={!supported || phase === "connecting"}
          >
            <Bluetooth size={17} />{" "}
            {phase === "connecting" ? "Connecting…" : "Connect scooter"}
          </button>
        ) : (
          <button className="button quiet" onClick={disconnect}>
            <Unplug size={16} /> Disconnect
          </button>
        )}
        {phase === "connected" && <span className="connected-dot" aria-live="polite">Connected</span>}
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {connection && (
        <>
          <div className="fact-grid">
            <Fact label="Device name" value={connection.name || "not advertised"} />
            <Fact
              label="UART profile"
              value={connection.gattProfile === "ninebot" ? "Ninebot custom" : connection.gattProfile === "nus" ? "Nordic UART" : "unknown"}
              hint="determines how the module talks"
            />
            <Fact
              label="Write mode"
              value={connection.writeMode === "response" ? "acknowledged" : connection.writeMode === "no-response" ? "unacknowledged" : "unknown"}
            />
            <Fact
              label="Model code"
              value={
                advertisement?.hardwareId
                  ? `${advertisement.hardwareId}`
                  : "not in advertisement"
              }
              hint={
                advertisement?.hardwareId
                  ? advertisement.hardwareId === 258
                    ? "258 = MAX G3"
                    : advertisement.hardwareId === 259
                      ? "259 = F3"
                      : "not a G3/F3 code"
                  : undefined
              }
            />
          </div>

        </>
      )}

      <h3 className="check-subhead">Add a reading</h3>
      <p className="muted small">
        Works without Bluetooth too - type what you can read in the app, on a
        label, or in a diagnostic screen. Only enter values you actually saw; a
        made-up reading is worse than none.
      </p>
      <div className="reading-grid">
        <label>
          <span>Serial number (14 characters)</span>
          <input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="1CG00000000001"
            autoComplete="off"
            maxLength={20}
            inputMode="text"
          />
          <small className="caption">Prefix 1CG = MAX G3, 1EF = F3</small>
        </label>
        <label>
          <span>VCU banner</span>
          <input
            value={banner}
            onChange={(e) => setBanner(e.target.value)}
            placeholder="SCOOTER_VCU_xxG3"
            autoComplete="off"
            maxLength={40}
          />
          <small className="caption">
            The MCU banner is identical on every model and is ignored.
          </small>
        </label>
      </div>

      {(phase === "connected" ||
        identity.status !== "unknown" ||
        serial ||
        banner) && (
        <div className={`verdict-card ${copy.tone}`} role="status" aria-live="polite">
          <span className="verdict-icon">
            {copy.tone === "ok" ? (
              <Check size={22} />
            ) : copy.tone === "warn" ? (
              <CircleHelp size={22} />
            ) : (
              <ShieldAlert size={22} />
            )}
          </span>
          <div>
            <strong>
              {identity.status === "verified"
                ? `${identity.canonicalName} - ${copy.title.toLowerCase()}`
                : copy.title}
            </strong>
            <p>{copy.body}</p>
            {identity.notes.length > 0 && (
              <ul className="verdict-notes">
                {identity.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            <p className="verdict-meta">
              status <code>{identity.status}</code> · model{" "}
              <code>{identity.model ?? "none"}</code> · sources{" "}
              <code>{identity.sources.length ? identity.sources.join(", ") : "none"}</code>
            </p>
          </div>
        </div>
      )}

      {identity.status === "verified" && (
        <div className="firmware-match">
          <h3 className="check-subhead">Firmware for {identity.canonicalName}</h3>
          {firmware.length ? (
            <ul>
              {firmware.map((f) => (
                <li key={f.id}>
                  <strong>{f.name}</strong>
                  <span>
                    {" "}
                    · {f.modelLabel} · {f.component}
                    {f.bytes ? ` · ${(f.bytes / 1024).toFixed(0)} KB` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Catalogue unavailable right now.</p>
          )}
          <p className="caption">
            Listing only. Writing firmware stays switched off until a qualified
            protocol profile exists.
          </p>
        </div>
      )}

      {connection && (
        <details className="report">
          <summary>
            <Info size={14} /> Report for support
          </summary>
          <pre>{report}</pre>
          <button className="button quiet small" onClick={copyReport}>
            <Copy size={14} /> {copied ? "Copied" : "Copy report"}
          </button>
        </details>
      )}
    </section>
  );
}
