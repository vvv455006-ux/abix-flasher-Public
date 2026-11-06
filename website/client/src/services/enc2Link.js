import { NinebotBleService } from "./ninebotBleService.js";
import { OVERHEAD, SYNC_BYTES } from "./enc2.js";

/**
 * Raw frame pipe for an enc2 session.
 *
 * The plaintext parser in NinebotBleService frames `LEN + 9` bodies. An
 * encrypted frame is `LEN + 13` and its payload is ciphertext, so this link
 * reassembles on its own length rule and hands whole wire frames to the
 * session. GATT discovery, chunking, timeouts and the write-mode negotiation
 * stay in NinebotBleService - there is exactly one BLE implementation.
 */
export class Enc2Link {
  constructor({ service = new NinebotBleService(), maxBuffer = 4096 } = {}) {
    this.service = service;
    this.maxBuffer = maxBuffer;
    this.buffer = [];
    this.handler = null;
    this.closed = false;
  }

  onFrame(handler) {
    this.handler = handler;
  }

  async connect({ acceptAllDevices = false } = {}) {
    // The qualification flag lives in the flash profile, which refuses to run
    // until an exact model is proven. The transport itself is just a pipe.
    await this.service.connect({
      profile: { qualified: true, simulated: false },
      acceptAllDevices,
    });
    this.service.encrypted = true;
    this.service.onRawBytes = (bytes) => this._feed(bytes);
    this.closed = false;
  }

  get isConnected() {
    return !!this.service.writeChar && !this.closed;
  }

  _feed(bytes) {
    for (const byte of bytes) this.buffer.push(byte);
    if (this.buffer.length > this.maxBuffer)
      this.buffer = this.buffer.slice(-Math.floor(this.maxBuffer / 2));

    for (;;) {
      // Resync on the sync pair. A header that claims a length is honoured, so
      // a frame truncated mid-transfer is only recovered after that many bytes
      // are consumed; a fresh connect clears the buffer instead.
      while (this.buffer.length >= 2 && !this._syncAt(0)) this.buffer.shift();
      if (this.buffer.length < 4) return;
      const total = this.buffer[2] + 7 + OVERHEAD;
      if (total < 13 || total > 300) {
        this.buffer.shift();
        continue;
      }
      if (this.buffer.length < total) return;
      const frame = Uint8Array.from(this.buffer.slice(0, total));
      this.buffer.splice(0, total);
      this.handler?.(frame);
    }
  }

  _syncAt(index) {
    return (
      this.buffer[index] === SYNC_BYTES[0] &&
      this.buffer[index + 1] === SYNC_BYTES[1]
    );
  }

  async writeRaw(bytes) {
    if (this.closed) throw new Error("Bluetooth link is closed");
    await this.service.write(bytes);
  }

  async disconnect() {
    this.closed = true;
    this.buffer = [];
    this.service.onRawBytes = null;
    this.service.encrypted = false;
    await this.service.disconnect();
  }
}
