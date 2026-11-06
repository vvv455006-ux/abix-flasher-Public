import React, { useState } from "react";
import {
  Bluetooth,
  Check,
  Layers,
  ShieldCheck,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { MODELS } from "../services/ninebotModel.js";
import { withCatalogMetadata } from "../data/firmwareTemplates.js";
import { fetchFirmwareImage } from "../services/firmwareApi.js";
import { runFirmwareFlash } from "../services/firmwareFlash.js";

const STAGE_LABEL = {
  download: "Bild wird geladen",
  connecting: "Bluetooth verbinden",
  handshake: "Handshake (Enc2)",
  identify: "Modell prüfen",
  entering: "IAP starten",
  transferring: "Blöcke werden geschrieben",
  verifying: "Neustart und Prüfung",
  rebooting: "Modul startet neu",
  confirmed: "Bestätigt",
};

function formatBytes(bytes) {
  if (!bytes) return "Größe unbekannt";
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function shortDigest(digest) {
  if (!digest) return "Digest folgt vom Server";
  return `${digest.slice(0, 8)}…${digest.slice(-8)}`;
}

export default function FirmwarePanel({
  catalog,
  detectedModel = null,
  credits = null,
  operator = false,
  onCreditsChange = () => {},
}) {
  const [model, setModel] = useState(detectedModel ?? "f3");
  const [selectedId, setSelectedId] = useState(null);
  const [check, setCheck] = useState({ battery: "", parked: false, single: false });
  const [run, setRun] = useState(null);

  const visible = withCatalogMetadata(catalog).filter(
    (entry) => entry.model === model,
  );
  const selected = visible.find((entry) => entry.id === selectedId) ?? null;
  const busy = Boolean(run) && !["done", "failed", "probed"].includes(run.stage);

  const update = (patch) => {
    setRun((current) => ({ ...(current ?? {}), ...patch }));
  };

  const probeImage = async (template) => {
    setRun({ stage: "download", percent: 0, message: "Bild wird geladen…" });
    try {
      // Probe: spends no credit (the server still requires 1 left, because
      // the full image is delivered — see firmwareApi.js).
      const { bytes, sha256, credits: balance } = await fetchFirmwareImage(
        template,
        { forFlash: false },
      );
      if (balance) onCreditsChange(balance);
      const blocks = Math.ceil(bytes.length / 128);
      let sum = 0;
      for (const byte of bytes) sum = (sum + byte) >>> 0;
      update({
        stage: "probed",
        percent: 100,
        message: `${formatBytes(bytes.length)} · ${blocks.toLocaleString("de-DE")} Blöcke · SHA-256 ${sha256.slice(0, 12)}… · IAP-Prüfsumme ${(~sum >>> 0)
          .toString(16)
          .padStart(8, "0")} · Probe verbraucht keinen Credit.`,
      });
    } catch (error) {
      update({ stage: "failed", message: error.message });
    }
  };

  const startFlash = async () => {
    if (!selected) return;
    if (operator) {
      setRun({
        stage: "failed",
        percent: 0,
        message:
          "Flashen geht nur mit einem User-Key. Bitte in ABI ADMIN einen Key erstellen und mit „Diesen Key verwenden“ anmelden.",
      });
      return;
    }
    if (credits && credits.remaining <= 0) {
      setRun({
        stage: "failed",
        percent: 0,
        message:
          "Keine Credits übrig. 1 Credit = 1 Flash — bitte einen neuen Key beim Admin holen.",
      });
      return;
    }
    setRun({ stage: "download", percent: 0, message: "Bild wird geladen…" });
    try {
      // Flash: 1 credit is spent by the server when the image is delivered,
      // before any Bluetooth write. A failed flash afterwards does not
      // refund the credit — the delivery already happened.
      const { bytes, sha256, credits: balance } = await fetchFirmwareImage(
        selected,
        { forFlash: true },
      );
      if (balance) onCreditsChange(balance);
      const result = await runFirmwareFlash({
        firmware: { ...selected, sha256 },
        bytes,
        checklist: {
          batteryPercent: Number(check.battery),
          parked: check.parked,
        },
        confirmSingleSource: check.single,
        onStage: (stage) =>
          update({ stage, message: STAGE_LABEL[stage] ?? stage, percent: 0 }),
        onProgress: (event) =>
          update({
            stage: event.phase === "transferring" ? "transferring" : event.phase,
            percent: event.percent ?? 0,
            message:
              event.phase === "transferring"
                ? `Block ${event.current?.toLocaleString("de-DE")} von ${event.total?.toLocaleString("de-DE")}`
                : STAGE_LABEL[event.phase] ?? event.phase,
          }),
      });
      update({
        stage: "done",
        percent: 100,
        message: `Bestätigt: ${result.evidence}. Seriennummer ${result.serial}.${
          balance
            ? ` Noch ${balance.remaining} von ${balance.total} Credits übrig.`
            : ""
        }`,
        result,
      });
    } catch (error) {
      update({
        stage: "failed",
        percent: 0,
        message: error.message,
        code: error.code ?? null,
      });
    }
  };

  return (
    <section className="panel firmware-panel" aria-labelledby="firmware-heading">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">BILDER</span>
          <h2 id="firmware-heading">Vorlagen für dein Display</h2>
        </div>
        <span className="tag">
          <Layers size={12} /> 2 pro Modell
        </span>
      </div>
      <p className="muted">
        Jedes Bild passt nur zu einem Modell. Wähle das Modell, dann die
        Vorlage — geschrieben wird ausschließlich das Bild, das zu dem beim
        Verbinden gelesenen Modell passt.
      </p>

      <div className="inline-notice" role="status">
        {operator ? (
          <>
            <ShieldCheck size={16} /> Operator-Login: Zum Flashen brauchst du
            einen User-Key — in ABI ADMIN erstellen und mit „Diesen Key
            verwenden“ anmelden.
          </>
        ) : credits ? (
          <>
            <Zap size={16} /> Credits: <strong>{credits.remaining} von {credits.total} übrig</strong>
            {" · "}1 Credit = 1 Flash. Der Credit wird beim Laden des Bildes
            verbraucht, die Prüfung („Bild prüfen“) verbraucht keinen.
            {credits.localOnly ? " Zähler nur auf diesem Gerät (kein Server)." : ""}
          </>
        ) : (
          <>
            <Zap size={16} /> Legacy-Key ohne Credit-Guthaben — bitte beim
            Admin einen neuen Key mit Credits holen (1 Credit = 1 Flash).
          </>
        )}
      </div>

      <div className="fw-tabs" role="tablist" aria-label="Modell">
        {Object.values(MODELS).map((entry) => (
          <button
            key={entry.model}
            role="tab"
            aria-selected={model === entry.model}
            className={`fw-tab ${model === entry.model ? "active" : ""}`}
            onClick={() => {
              setModel(entry.model);
              setSelectedId(null);
              setRun(null);
            }}
          >
            {entry.canonicalName}
          </button>
        ))}
      </div>

      <div className="fw-grid">
        {visible.map((template) => {
          const active = template.id === selectedId;
          return (
            <button
              key={template.id}
              className={`fw-card ${active ? "active" : ""}`}
              onClick={() => {
                setSelectedId(template.id);
                setRun(null);
              }}
              aria-pressed={active}
            >
              <span className="fw-badge">VORLAGE</span>
              <strong>{template.brand}</strong>
              <span className="fw-model">{template.modelLabel}</span>
              <span className="fw-file">{template.file ?? template.id}</span>
              <span className="fw-meta">
                {formatBytes(template.bytes)} · {shortDigest(template.sha256)}
              </span>
              <span className="fw-pick">
                {active ? (
                  <>
                    <Check size={14} /> ausgewählt
                  </>
                ) : (
                  "auswählen"
                )}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="fw-review">
          <div className="fw-review-head">
            <Zap size={18} />
            <div>
              <strong>
                {selected.brand} · {selected.modelLabel}
              </strong>
              <p className="muted small">
                {selected.file ?? selected.id} · {formatBytes(selected.bytes)}
              </p>
            </div>
          </div>

          <div className="fw-checklist">
            <label>
              Akkustand (%)
              <input
                type="number"
                min="0"
                max="100"
                inputMode="numeric"
                value={check.battery}
                onChange={(event) =>
                  setCheck((current) => ({ ...current, battery: event.target.value }))
                }
                placeholder="z. B. 62"
              />
            </label>
            <label className="fw-check">
              <input
                type="checkbox"
                checked={check.parked}
                onChange={(event) =>
                  setCheck((current) => ({ ...current, parked: event.target.checked }))
                }
              />
              Roller steht, ist aus und hängt nicht am Ladegerät
            </label>
            <label className="fw-check">
              <input
                type="checkbox"
                checked={check.single}
                onChange={(event) =>
                  setCheck((current) => ({ ...current, single: event.target.checked }))
                }
              />
              Falls der Browser keine zweite Modellquelle liefert: Modell aus dem
              Serienpräfix bestätigen
            </label>
          </div>

          <div className="fw-actions">
            <button
              className="button primary"
              onClick={startFlash}
              disabled={
                busy ||
                !check.parked ||
                !check.battery ||
                operator ||
                (credits ? credits.remaining <= 0 : false)
              }
            >
              <Bluetooth size={16} /> Auf Roller schreiben
            </button>
            <button
              className="button quiet"
              onClick={() => probeImage(selected)}
              disabled={busy}
            >
              Bild prüfen (ohne Roller)
            </button>
          </div>

          {run && (
            <div className={`fw-run ${run.stage === "failed" ? "bad" : ""}`} role="status">
              <div className="fw-run-head">
                {run.stage === "failed" ? (
                  <TriangleAlert size={16} />
                ) : run.stage === "done" ? (
                  <ShieldCheck size={16} />
                ) : null}
                <strong>{STAGE_LABEL[run.stage] ?? (run.stage === "probed" ? "Bild geprüft" : run.stage)}</strong>
              </div>
              {typeof run.percent === "number" && run.stage === "transferring" && (
                <progress value={run.percent} max="100" />
              )}
              <p className="muted small">{run.message}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
