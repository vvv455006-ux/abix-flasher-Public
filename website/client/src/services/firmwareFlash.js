import { FlashEngine, FlashError } from "./flashEngine.js";
import { Enc2Link } from "./enc2Link.js";
import { Enc2Session } from "./enc2Session.js";
import { BLE_BOARD } from "./enc2.js";
import {
  CMD,
  PROTOCOL,
  REG,
  readRegister,
} from "./ninebotProtocol.js";
import { identifyDevice, MODELS } from "./ninebotModel.js";

const PASSWORD_PREFIX = "abi.enc2.pwd.";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function base64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text) {
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function loadDevicePassword(name) {
  try {
    const raw = localStorage.getItem(PASSWORD_PREFIX + name);
    return raw ? fromBase64(raw) : null;
  } catch {
    return null;
  }
}

export function storeDevicePassword(name, password) {
  try {
    localStorage.setItem(PASSWORD_PREFIX + name, base64(password));
  } catch {
    /* storage disabled: the pairing simply has to be redone next visit */
  }
}

function requireChecklist(checklist) {
  const battery = Number(checklist?.batteryPercent);
  if (!Number.isFinite(battery) || battery < 30 || battery > 100)
    throw new FlashError(
      "TELEMETRY_UNSAFE",
      "Checkliste unvollständig: Akkustand zwischen 30 und 100 % eintragen.",
    );
  if (checklist?.parked !== true)
    throw new FlashError(
      "TELEMETRY_UNSAFE",
      "Checkliste unvollständig: Roller muss stehen und ausgeschaltet am Ladegerät getrennt sein.",
    );
  return battery;
}

/**
 * Flash one display image over Bluetooth.
 *
 * The whole session runs on enc2: PRE_COMM/SET_PWD/AUTH first, then the IAP
 * sequence from FlashEngine. Identity is proven from the serial the vehicle
 * returns during the handshake plus the hardware id from the advertisement
 * when the browser exposes it; with only one source the operator has to
 * confirm the model explicitly (`confirmSingleSource`).
 */
export async function runFirmwareFlash({
  firmware,
  bytes,
  checklist,
  confirmSingleSource = false,
  onProgress = () => {},
  onStage = () => {},
  signal,
}) {
  const batteryPercent = requireChecklist(checklist);
  const engine = new FlashEngine();
  const link = new Enc2Link();
  const transport = {
    isSimulator: false,
    link,
    session: null,
    advertisement: null,
    async write(packet) {
      return this.session.write(packet);
    },
    async transact(packet, match, { signal: innerSignal, timeoutMs } = {}) {
      innerSignal?.throwIfAborted?.();
      return this.session.request(packet, { match, timeoutMs });
    },
    async disconnect() {
      await this.link.disconnect().catch(() => {});
    },
  };

  try {
    onStage("connecting");
    await link.connect();
    const name = link.service.device?.name ?? "";
    const session = new Enc2Session(link);
    transport.session = session;
    onStage("handshake");
    const opened = await session.open({
      name,
      password: loadDevicePassword(name),
    });
    storeDevicePassword(name, opened.password);

    onStage("identify");
    const advertisement = await link.service
      .readAdvertisement({ timeoutMs: 4000 })
      .catch(() => null);
    transport.advertisement = advertisement;

    let identity = identifyDevice({
      serial: opened.serial,
      hardwareId: advertisement?.hardwareId ?? undefined,
    });
    if (identity.status === "provisional" && confirmSingleSource) {
      identity = {
        ...identity,
        status: "verified",
        sources: [...identity.sources, "operator-confirmed"],
        notes: [
          ...(identity.notes ?? []),
          "Zweite Quelle fehlt; das Modell wurde vom Bediener bestätigt.",
        ],
      };
    }
    if (identity.status !== "verified")
      throw new FlashError(
        "IDENTITY_UNVERIFIED",
        `Modell nicht belegt (${identity.status}). Serienpräfix allein reicht nur mit ausdrücklicher Bestätigung.`,
      );
    if (identity.model !== firmware.model)
      throw new FlashError(
        "MODEL_MISMATCH",
        `Gerät ist ${MODELS[identity.model]?.canonicalName ?? identity.model}, das Bild ist für ${MODELS[firmware.model]?.canonicalName ?? firmware.model}. Abgelehnt.`,
      );

    const profile = {
      qualified: true,
      simulated: false,
      model: identity.model,
      protocol: PROTOCOL.ninebot,
      target: BLE_BOARD,
      blockSize: 128,
      supportsBlockRetry: true,
      beginTimeoutMs: 15000,
      blockTimeoutMs: 10000,
      verifyTimeoutMs: 20000,
      resetSpacingMs: 120,
      readIdentity: async () => ({
        ...identity,
        model: identity.model,
        deviceId: opened.serial,
      }),
      readTelemetry: async () => ({
        batteryPercent,
        speed: 0,
        readAt: Date.now(),
        attested: true,
      }),
      verifyInstalled: async () => {
        // The module reboots after 0x0A. Reading the version back is the only
        // confirmation this bootloader can give; there is no digest command.
        onStage("verifying");
        await transport.disconnect();
        await sleep(3500);
        const again = new Enc2Link();
        try {
          await again.connect();
          const next = new Enc2Session(again);
          await next.open({ name, password: opened.password });
          const reply = await next.request(
            readRegister(BLE_BOARD, REG.FIRMWARE_VERSION, 2),
            {
              match: (p) =>
                p.cmd === CMD.READ_REPLY && p.reg === REG.FIRMWARE_VERSION,
              timeoutMs: 6000,
            },
          );
          const version = [...reply.data]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          return {
            confirmed: true,
            model: identity.model,
            sha256: null,
            evidence: `Ziel-ACK 0x09 + Version 0x${version} nach Neustart`,
            version,
          };
        } catch {
          return { confirmed: false, model: identity.model, sha256: null };
        } finally {
          await again.disconnect().catch(() => {});
        }
      },
    };

    const result = await engine.run({
      bytes,
      firmware,
      profile,
      transport,
      signal,
      onProgress: (event) => {
        if (event.phase === "entering") onStage("entering");
        if (event.phase === "transferring") onStage("transferring");
        if (event.phase === "verifying") onStage("verifying");
        if (event.phase === "rebooting") onStage("rebooting");
        onProgress(event);
      },
    });
    onStage("confirmed");
    return { ...result, serial: opened.serial, identity };
  } finally {
    await transport.disconnect().catch(() => {});
  }
}
