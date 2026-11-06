import { FrameParser } from "./codec.js";
import { encodeFrame, PROTOCOL } from "./ninebotProtocol.js";
import { identifyDevice } from "./ninebotModel.js";

/**
 * Ninebot GATT profiles, newest first.
 *
 * The stock Nordic UART UUID is NOT what current Segway-Ninebot hardware uses.
 * Modern modules expose 6e400001-0000-0000-006e-696e65626f74 ("\0ninebot"),
 * and their notification characteristic is 0004 - 0003 is a secondary write
 * channel. A tool that filters on stock NUS sees no device at all, or connects
 * and never receives a reply, which is usually misreported as "no
 * acknowledgment".
 *
 * Sources: nootnooot.codeberg.page/segway-ninebot-ble/transport
 */
export const NINEBOT_SERVICE_UUID = "6e400001-0000-0000-006e-696e65626f74";
export const NINEBOT_WRITE_UUID = "6e400002-0000-0000-006e-696e65626f74";
export const NINEBOT_NOTIFY_UUID = "6e400004-0000-0000-006e-696e65626f74";

export const NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const PROFILES = [
  {
    name: "ninebot",
    service: NINEBOT_SERVICE_UUID,
    write: NINEBOT_WRITE_UUID,
    notify: NINEBOT_NOTIFY_UUID,
  },
  {
    name: "nus",
    service: NUS_SERVICE_UUID,
    write: NUS_RX_UUID,
    notify: NUS_TX_UUID,
  },
];

/** Portable ATT payload ceiling. Chrome exposes no MTU API to negotiate or read. */
export const DEFAULT_CHUNK = 20;

const sleep = (ms) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export function identifyModel({ rawModelCode = "" } = {}) {
  const code = String(rawModelCode).trim().toLowerCase();
  const exact = ["g3", "f3"].includes(code);
  return {
    modelCode: exact ? code : "unknown",
    canonicalName: exact
      ? "Ninebot " + code.toUpperCase()
      : "Unverified hardware",
    confidence: exact ? "declared" : "unknown",
    evidence: [],
  };
}

export class NinebotBleService {
  static buildPacket = (target, command, register, payload) =>
    encodeFrame({
      protocol: PROTOCOL.ninebot,
      target,
      command,
      argument: register,
      payload,
    });

  static isWebBluetoothSupported() {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.bluetooth &&
      globalThis.isSecureContext
    );
  }

  constructor() {
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.profileKind = null;
    this.listeners = new Set();
    this.onNotificationCallback = null;
    this.parser = new FrameParser((p) => {
      this.onNotificationCallback?.(p);
      for (const listener of this.listeners) listener(null, p);
    });
    this.isSimulator = false;
    this.chunkSize = DEFAULT_CHUNK;
    this.writeMode = null; // "response" | "no-response"
    // Public diagnosis runs without a licence or a qualified flash profile and
    // must not be able to emit a single protocol byte.
    this.readOnly = false;
    this._gattChain = Promise.resolve();
    this._lastWrite = null;
    // Only a live connection needs the stale-notification drain; a detached
    // service must still parse whatever it is handed.
    this._draining = false;
    this.onDisconnect = () => {
      for (const fn of this.listeners)
        fn(new Error("Bluetooth disconnected"));
      this.listeners.clear();
    };
  }

  processIncomingBytes(view) {
    // Stale notifications from a previous session arrive before the first
    // response and would be parsed as answers. Drain, do not deliver.
    if (this._draining) return;
    const bytes =
      view instanceof DataView
        ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        : new Uint8Array(view);
    // Some bonded reconnects echo writes back verbatim. Never treat that as a
    // device response.
    if (this._lastWrite && equalsBytes(bytes, this._lastWrite)) return;
    // An encrypted session reassembles its own frames; the plaintext parser
    // would only ever see ciphertext it cannot frame.
    this.onRawBytes?.(bytes);
    if (this.encrypted) return;
    this.parser.push(bytes);
  }

  /**
   * Serialize every GATT call. Web Bluetooth does not queue operations, and a
   * timeout/retry that overlaps a pending write produces
   * "GATT operation already in progress", then a dead link.
   */
  _gatt(operation) {
    const run = this._gattChain.then(operation, operation);
    this._gattChain = run.catch(() => {});
    return run;
  }

  async connect({ profile, acceptAllDevices = false } = {}) {
    if (!profile?.qualified || profile.simulated)
      throw new Error(
        "No hardware-qualified G3/F3 profile is installed. Real flashing remains disabled.",
      );
    return this._connect({ profile, acceptAllDevices, readOnly: false });
  }

  /**
   * Open a connection that can only read. No licence, no flash profile, and
   * `write()` refuses - so "public diagnosis" is a property of the transport,
   * not a promise the UI makes.
   */
  async connectReadOnly({ acceptAllDevices = true } = {}) {
    return this._connect({
      profile: { readOnly: true, qualified: false },
      acceptAllDevices,
      readOnly: true,
    });
  }

  async _connect({ profile, acceptAllDevices, readOnly }) {
    if (!NinebotBleService.isWebBluetoothSupported())
      throw new Error(
        "Use supported desktop or Android Chrome. iOS has no Web Bluetooth.",
      );
    this.readOnly = readOnly;
    try {
      this.device = await navigator.bluetooth.requestDevice(
        acceptAllDevices
          ? { acceptAllDevices: true, optionalServices: PROFILES.map((p) => p.service) }
          : {
              filters: PROFILES.map((p) => ({ services: [p.service] })),
              optionalServices: PROFILES.map((p) => p.service),
            },
      );
      this.device.addEventListener("gattserverdisconnected", this.onDisconnect);
      this.server = await this._gatt(() => this.device.gatt.connect());
      await this._resolveCharacteristics();
      this.profile = profile;
      return { kind: this.profileKind, writeMode: this.writeMode };
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }

  /**
   * Service discovery has to tolerate both UUID sets and both notify
   * characteristics. Failure here names what was found, because "connects but
   * never replies" is otherwise indistinguishable from a wrong image.
   */
  async _resolveCharacteristics() {
    const found = [];
    for (const candidate of PROFILES) {
      let service;
      try {
        service = await this._gatt(() =>
          this.server.getPrimaryService(candidate.service),
        );
      } catch {
        continue;
      }
      let writeChar, notifyChar;
      try {
        writeChar = await this._gatt(() =>
          service.getCharacteristic(candidate.write),
        );
      } catch {
        continue;
      }
      // 0004 is the notify channel on the Ninebot service; some modules also
      // expose the secondary 0003 write channel, so both are probed.
      const notifyCandidates =
        candidate.name === "ninebot"
          ? [NINEBOT_NOTIFY_UUID, "6e400003-0000-0000-006e-696e65626f74"]
          : [NUS_TX_UUID];
      for (const uuid of notifyCandidates) {
        try {
          notifyChar = await this._gatt(() => service.getCharacteristic(uuid));
          break;
        } catch {
          /* try the next notify characteristic */
        }
      }
      if (!notifyChar) continue;
      found.push({ ...candidate, service, writeChar, notifyChar });
    }

    if (found.length === 0)
      throw new Error(
        "No writable Ninebot/NUS UART service on this device. The vehicle is probably not this module, or it is a firmware generation this profile does not address.",
      );
    if (found.length > 1)
      throw new Error(
        "Device exposes more than one UART service; refusing to guess which one is the protocol channel.",
      );

    const chosen = found[0];
    this.profileKind = chosen.name;
    this.writeChar = chosen.writeChar;
    this.notifyChar = chosen.notifyChar;

    const props = this.writeChar.properties ?? {};
    if (props.write) this.writeMode = "response";
    else if (props.writeWithoutResponse) this.writeMode = "no-response";
    else
      throw new Error(
        "The write characteristic supports neither acknowledged nor unacknowledged writes.",
      );

    this._draining = true;
    this.parser.reset();
    this.notifyChar.addEventListener(
      "characteristicvaluechanged",
      (this.notification = (e) => this.processIncomingBytes(e.target.value)),
    );
    await this._gatt(() => this.notifyChar.startNotifications());
    await sleep(200); // let cached/stale notifications land and be discarded
    this.parser.reset();
    this._draining = false;
  }

  /**
   * Send one frame, split at the ATT payload boundary.
   *
   * The previous implementation hard-coded 20-byte writes and required
   * write-with-response, so it aborted outright on modules that only advertise
   * write-without-response. Unacknowledged writes are paced instead.
   */
  async write(packet) {
    if (this.readOnly)
      throw new Error(
        "This connection is read-only. Reconnect with a qualified flash profile to write.",
      );
    if (!this.device?.gatt.connected || !this.writeChar)
      throw new Error("Bluetooth disconnected");
    const bytes =
      packet instanceof Uint8Array ? packet : new Uint8Array(packet);
    this._lastWrite = bytes;
    const size = this.chunkSize;
    for (let offset = 0; offset < bytes.length; offset += size) {
      const fragment = bytes.slice(offset, offset + size);
      await this._gatt(async () => {
        if (this.writeMode === "response")
          await this.writeChar.writeValueWithResponse(fragment);
        else await this.writeChar.writeValueWithoutResponse(fragment);
      });
      if (this.writeMode === "no-response" || offset + size < bytes.length)
        await sleep(this.writeMode === "no-response" ? 10 : 0);
    }
  }

  /**
   * One request, one reply.
   *
   * The timeout is derived from how long the write chain can legitimately
   * take, not a fixed 1500 ms that fires while acknowledged writes are still
   * in flight.
   */
  async transact(packet, match, { signal, timeoutMs } = {}) {
    signal?.throwIfAborted();
    const chunks = Math.ceil(packet.length / this.chunkSize);
    const budget =
      timeoutMs ??
      Math.max(3000, chunks * (this.writeMode === "no-response" ? 150 : 250));
    let listener, abort;
    const reply = new Promise((resolve, reject) => {
      listener = (err, p) => {
        if (err) reject(err);
        else if (match(p)) resolve(p);
      };
      this.listeners.add(listener);
      abort = () =>
        reject(signal.reason || new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
    });
    reply.catch(() => {}); // a write failure must not leave an unhandled reject
    const timer = setTimeout(() => {
      this.listeners.delete(listener);
      const error = new Error(
        `No acknowledgment within ${budget} ms (${chunks} GATT writes, ${this.writeMode}).`,
      );
      error.code = "ACK_TIMEOUT";
      error.retryable = true;
      listener(error);
    }, budget);
    try {
      const [, response] = await Promise.all([this.write(packet), reply]);
      return response;
    } finally {
      clearTimeout(timer);
      this.listeners.delete(listener);
      signal?.removeEventListener("abort", abort);
    }
  }

  /**
   * Advertisement-level identity. Read-only, no protocol writes.
   *
   * `manufacturerData` is the only trustworthy off-wire hint: company id
   * 0x424E carries the vendor's internal model code in its first byte. It is
   * still treated as one source, never as proof - see ninebotModel.js.
   */
  async readAdvertisement({ timeoutMs = 5000 } = {}) {
    const facts = {
      name: this.device?.name ?? null,
      hardwareId: null,
      encryptionVersion: null,
      sources: [],
    };
    if (!this.device)
      throw new Error("Connect first; the advertisement belongs to the device");
    if (typeof this.device.watchAdvertisements !== "function")
      return { ...facts, supported: false };

    const event = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const onEvent = (e) => {
        clearTimeout(timer);
        this.device.removeEventListener("advertisementreceived", onEvent);
        resolve(e);
      };
      this.device.addEventListener("advertisementreceived", onEvent);
      this.device.watchAdvertisements().catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    if (!event) return { ...facts, supported: true };

    facts.name = event.name ?? facts.name;
    const manufacturerData = event.manufacturerData;
    if (manufacturerData?.forEach)
      manufacturerData.forEach((view, companyId) => {
        const bytes = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
        if (bytes.length === 0) return;
        if (companyId === 0x424e) {
          facts.hardwareId = bytes[0];
          facts.sources.push("manufacturer-data:0x424e");
        }
        if ((companyId === 0x4e42 || companyId === 0x4e43) && bytes.length > 1)
          facts.encryptionVersion = bytes[0];
      });
    return { ...facts, supported: true };
  }

  /**
   * Read-only diagnosis. Produces the evidence set `identifyDevice` needs and
   * never writes a protocol frame, so it is safe to run before any flash.
   */
  async diagnose({ serial, vcuBanner } = {}) {
    const advertisement = await this.readAdvertisement().catch(() => ({
      supported: false,
      name: this.device?.name ?? null,
      hardwareId: null,
      sources: [],
    }));
    const identity = identifyDevice({
      hardwareId: advertisement.hardwareId ?? undefined,
      serial,
      vcuBanner,
      bleName: advertisement.name ?? undefined,
    });
    return {
      deviceName: advertisement.name,
      gattProfile: this.profileKind,
      writeMode: this.writeMode,
      advertisementSupported: advertisement.supported,
      advertisementHardwareId: advertisement.hardwareId,
      encryptionVersion: advertisement.encryptionVersion,
      identity,
    };
  }

  async disconnect() {
    this.onDisconnect();
    this._draining = true;
    try {
      if (this.notifyChar && this.notification)
        this.notifyChar.removeEventListener(
          "characteristicvaluechanged",
          this.notification,
        );
    } catch {}
    try {
      this.device?.removeEventListener(
        "gattserverdisconnected",
        this.onDisconnect,
      );
      if (this.device?.gatt.connected) this.device.gatt.disconnect();
    } catch {}
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.profileKind = null;
    this.writeMode = null;
    this.readOnly = false;
    this._lastWrite = null;
    this.parser.reset();
  }
}

function equalsBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const bleService = new NinebotBleService();
