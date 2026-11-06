import {
  BLE_BOARD,
  ENC2_CMD,
  FW_DATA,
  decryptFrame,
  deriveKey,
  encryptFrame,
  plainFrame,
  readPlainFrame,
} from "./enc2.js";

const sleep = (ms) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

function asciiBytes(text) {
  return Uint8Array.from(String(text ?? ""), (c) => c.charCodeAt(0) & 0xff);
}

function asciiText(bytes) {
  return [...bytes].map((b) => String.fromCharCode(b)).join("");
}

/**
 * A fresh 16-byte password for SET_PWD.
 *
 * The official app derives it from a Java LCG seeded with the challenge, which
 * only matters if its password has to be reproduced later. Any 16 bytes are
 * accepted at pairing, so this uses the platform CSPRNG and stores the result.
 */
function newPassword() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return raw.subarray(0, 16);
}

/**
 * One authenticated enc2 session.
 *
 * Frame counters: `tx` counts our outgoing authenticated frames (the first is
 * 2, matching the reference clients); `lastRx` guards replay. PRE_COMM is the
 * only unauthenticated frame and always travels with counter 0.
 */
export class Enc2Session {
  constructor(link, { timeoutMs = 2500 } = {}) {
    this.link = link;
    this.timeoutMs = timeoutMs;
    this.key = null;
    this.authParam = null;
    this.name = "";
    this.serial = "";
    this.tx = 0;
    this.lastRx = -1;
    this.pending = null;
    this.closed = false;
    link.onFrame((frame) => this._onFrame(frame));
  }

  /**
   * Run the handshake.
   *
   * @param {object} spec
   * @param {string} spec.name      GATT device name (the serial in practice)
   * @param {Uint8Array|null} [spec.password] previously stored password
   * @returns {Promise<{serial: string, password: Uint8Array, hadPassword: boolean}>}
   */
  async open({ name, password = null }) {
    this.name = String(name ?? "").trim();
    if (!this.name) throw new Error("BLE name is empty; it is part of the key");
    this.key = await deriveKey(this.name, FW_DATA);
    this.tx = 0;
    this.lastRx = -1;

    const pre = await this._transact(
      plainFrame(BLE_BOARD, ENC2_CMD.PRE_COMM, 0),
      { counter: 0, timeoutMs: 3000, retries: 3 },
    );
    if (pre.data.length < 30)
      throw new Error(
        `PRE_COMM returned ${pre.data.length} payload bytes, expected 30`,
      );
    this.authParam = pre.data.slice(0, 16);
    this.serial = asciiText(pre.data.slice(16, 30));
    const hadPassword = pre.reg !== 0;

    if (hadPassword && password?.length === 16) {
      const auth = await this._authenticate(password);
      if (auth.reg === 1)
        return { serial: this.serial, password, hadPassword };
      // Stored secret is stale; fall through and pair again.
      this.tx = 1;
    }

    const fresh = password?.length === 16 ? password : newPassword();
    this.key = await deriveKey(this.name, this.authParam);
    this.tx = 1;
    const set = await this._transact(
      plainFrame(BLE_BOARD, ENC2_CMD.SET_PWD, 0, fresh),
      { timeoutMs: 4000 },
    );
    // INDEX 0 means the vehicle is waiting for a physical confirmation; it is
    // polled here because the reference client does the same for ~60 s.
    let accepted = set.reg === 1;
    for (let attempt = 0; !accepted && attempt < 25; attempt++) {
      await sleep(2000);
      this.key = await deriveKey(this.name, this.authParam);
      const again = await this._transact(
        plainFrame(BLE_BOARD, ENC2_CMD.SET_PWD, 0, fresh),
        { timeoutMs: 4000 },
      );
      accepted = again.reg === 1;
    }
    if (!accepted)
      throw new Error(
        "SET_PWD stayed unconfirmed. The vehicle expects a physical confirmation (power button) and did not accept the new password.",
      );

    const auth = await this._authenticate(fresh);
    if (auth.reg !== 1)
      throw new Error("AUTH was rejected by the vehicle");
    return { serial: this.serial, password: fresh, hadPassword };
  }

  async _authenticate(password) {
    this.key = await deriveKey(password, this.authParam);
    return this._transact(
      plainFrame(BLE_BOARD, ENC2_CMD.AUTH, 0, asciiBytes(this.serial)),
      { timeoutMs: 3000 },
    );
  }

  /**
   * Authenticated request/reply. Returns the decoded reply packet.
   *
   * `match` decides which reply belongs to the request; the default is the
   * echo of the request opcode, which is how handshake replies behave. The IAP
   * flow answers every command with 0x0B, so it passes its own predicate.
   */
  async request(
    plaintext,
    { timeoutMs = this.timeoutMs, retries = 0, match = null } = {},
  ) {
    return this._transact(plaintext, { timeoutMs, retries, match });
  }

  /** Fire and forget (MCU reset has no reply). */
  async write(plaintext) {
    if (this.closed) throw new Error("Session is closed");
    const frame = await encryptFrame({
      key: this.key,
      counter: ++this.tx,
      authParam: this.authParam,
      plaintext: plaintext instanceof Uint8Array ? plaintext : plaintext,
    });
    await this.link.writeRaw(frame);
  }

  async _transact(
    plaintext,
    { counter = null, timeoutMs, retries = 0, match = null },
  ) {
    if (this.closed) throw new Error("Session is closed");
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._attempt(plaintext, counter, timeoutMs, match);
      } catch (error) {
        if (attempt >= retries || counter !== 0) throw error;
        await sleep(400);
      }
    }
  }

  async _attempt(plaintext, counter, timeoutMs, match) {
    const useCounter = counter ?? ++this.tx;
    const frame = await encryptFrame({
      key: this.key,
      counter: useCounter,
      authParam: this.authParam,
      plaintext,
      ecbInput: FW_DATA,
    });
    const expectedCmd = plaintext[5];
    const accepts =
      typeof match === "function"
        ? match
        : (packet) => packet.cmd === expectedCmd;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.reject === reject) this.pending = null;
        reject(
          new Error(
            `No enc2 reply within ${timeoutMs} ms (cmd 0x${expectedCmd.toString(16)}).`,
          ),
        );
      }, timeoutMs);
      this.pending = {
        reject,
        resolve: (packet) => {
          clearTimeout(timer);
          this.pending = null;
          resolve(packet);
        },
      };
      this.pendingMatches = accepts;
    });
    try {
      await this.link.writeRaw(frame);
    } catch (error) {
      clearTimeout(timer);
      this.pending = null;
      throw error;
    }
    return reply;
  }

  _onFrame(raw) {
    decryptFrame({
      key: this.key,
      authParam: this.authParam,
      frame: raw,
      ecbInput: FW_DATA,
    })
      .then((result) => {
        if (!result.ok) return;
        if (result.counter > 0) {
          if (result.counter <= this.lastRx) return;
          this.lastRx = result.counter;
        }
        const packet = readPlainFrame(result.plaintext);
        if (this.pendingMatches?.(packet)) this.pending?.resolve(packet);
      })
      .catch(() => {});
  }

  close() {
    this.closed = true;
    this.pending?.reject?.(new Error("Session closed"));
    this.pending = null;
  }
}
