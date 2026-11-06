/**
 * Ninebot serial protocol, wire-accurate.
 *
 * Two framings exist and they are not interchangeable:
 *
 *   Protocol 2 (0x5A 0xA5) - every BLE protocol variant, and every x3 vehicle
 *     (MAX G3 HW 258, F3 HW 259, GT3, ZT3). This is the one that matters here.
 *
 *   Protocol 1 (0x55 0xAA) - legacy Ninebot One / Mini and Xiaomi M365.
 *     No x3 vehicle speaks it.
 *
 * Protocol 2 layout:
 *   5A A5 | LEN | BT_ID | TARGET_ID | CMD | ARG | PAYLOAD[LEN] | CKLO CKHI
 *   - LEN is the payload byte count only; total frame = LEN + 9.
 *   - BT_ID is the protocol-layer constant 0x3E and comes FIRST. Boards
 *     silently discard frames whose BT_ID is not 0x3E, so a frame with the
 *     board id in this slot is never routed at all.
 *   - TARGET_ID follows BT_ID. The documented read-serial frame is
 *     `5A A5 02 3E 20 01 10 0E 00 7C FF` - 0x3E (app) then 0x20 (board).
 *     The original builder emitted `... 20 3E ...`, addresses reversed.
 *   - TARGET_ID addressing for x3 (from the vendor device configs):
 *       0x01 DIS  0x02 MCU  0x04 BLE  0x06 BMS2  0x07 BMS1
 *       0x09 ECU/VCU  0x16 VCU  0x20 CHG  0x23 TFT
 *     On x3 there is NO ESC at 0x20 - 0x20 is the charger.
 *   - Checksum is ~sum16 over LEN..last payload byte, little endian.
 *
 * Protocol 1 layout:
 *   55 AA | LEN | ADDR | CMD | ARG | PAYLOAD[LEN-2] | CKLO CKHI
 *   - LEN counts CMD+ARG+payload, so total frame = LEN + 6.
 *
 * Sources: github.com/etransport/ninebot-docs (protocol + ES2ESC registers),
 * github.com/Vicy-DE/Ninebot-G30-Custom (decompiled checksum + frame length),
 * nootnooot.codeberg.page/segway-ninebot-ble (transport, board addressing).
 */

export const FRAME_MAGIC = Object.freeze({
  legacy: [0x55, 0xaa],
  ninebot: [0x5a, 0xa5],
});

export const PROTOCOL = Object.freeze({ legacy: 1, ninebot: 2 });

/** Protocol-layer constant carried in every protocol-2 frame. */
export const BT_ID = 0x3e;

/** x3 board targets. Addressed per family config, not per legacy 0x20/0x22. */
export const BOARD = Object.freeze({
  DIS: 0x01,
  MCU: 0x02,
  BLE: 0x04,
  BMS2: 0x06,
  BMS1: 0x07,
  ECU: 0x09,
  VCU: 0x16,
  CHG: 0x20,
  TFT: 0x23,
});

/** Command opcodes. Read/write replies use their own opcode. */
export const CMD = Object.freeze({
  READ: 0x01,
  WRITE: 0x02,
  WRITE_NR: 0x03,
  READ_REPLY: 0x04,
  WRITE_REPLY: 0x05,
  IAP_BEGIN: 0x07,
  IAP_BLOCK: 0x08,
  IAP_VERIFY: 0x09,
  MCU_RESET: 0x0a,
  IAP_ACK: 0x0b,
});

/**
 * IAP result codes returned in the ACK's ARG byte.
 * 0x06 BUSY is expected while flash is being erased or written - it is not a
 * failure, the same block index must be resent.
 */
export const IAP_ERROR = Object.freeze({
  0x00: "OK",
  0x01: "SIZE",
  0x02: "ERASE",
  0x03: "WRITEFLASH",
  0x04: "UNLOCK",
  0x05: "INDEX",
  0x06: "BUSY",
  0x07: "FORM",
  0x08: "CRC",
  0x09: "RESET",
});

/**
 * 0x07 FORM is the single most misdiagnosed code in this family: the transport
 * is fine, the device rejected the image itself (length not a multiple of 8, or
 * downgrade/model protection on newer firmware).
 */
export const IAP_ERROR_MEANING = Object.freeze({
  SIZE: "firmware image is larger than the target's IAP window",
  ERASE: "target failed to erase the application area",
  WRITEFLASH: "target failed to write flash",
  UNLOCK: "target reports the image is not writable",
  INDEX: "block index out of sequence",
  BUSY: "target flash is busy - resend the same block index",
  FORM: "data format rejected (length not a multiple of 8, or model/downgrade protection)",
  CRC: "target checksum verification failed",
  RESET: "target reported a reset/other error",
});

/** Registers used for identification. They are per-board namespaces. */
export const REG = Object.freeze({
  SERIAL: 0x10, // 14 ASCII bytes, on DIS/BLE/VCU
  FIRMWARE_VERSION: 0x1a, // 2 bytes, on the board being addressed
  MODEL_STRING: 0x69, // 16 ASCII bytes, BLE only, absent on older firmware
});

/** IAP block size the bootloader expects when it has no other requirement. */
export const IAP_BLOCK_SIZE = 128;

/** Largest single-frame payload for protocol 2 (LEN is one byte). */
export const MAX_PAYLOAD = 255;

class ProtocolError extends Error {}

/**
 * One's complement of a 16-bit sum.
 *
 * The original code used `String.prototype`-free `sum ^ 0xffff`, which is only
 * correct while the sum fits in 16 bits. A 259-byte body sums past 0xffff and
 * silently produced a wrong checksum - no reply, reported as a timeout.
 */
export function checksum16(bytes) {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) & 0xffff;
  return ~sum & 0xffff;
}

function requireByte(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff)
    throw new ProtocolError(`${name} must be a byte`);
}

/**
 * Build one frame.
 *
 * @param {object} spec
 * @param {number} spec.protocol  PROTOCOL.ninebot (default) or PROTOCOL.legacy
 * @param {number} spec.target    board target id
 * @param {number} spec.command   CMD.*
 * @param {number} [spec.argument] register or block index
 * @param {ArrayLike<number>} [spec.payload]
 * @returns {Uint8Array}
 */
export function encodeFrame({
  protocol = PROTOCOL.ninebot,
  target,
  command,
  argument = 0,
  payload = [],
}) {
  requireByte("target", target);
  requireByte("command", command);
  requireByte("argument", argument);
  const body = Array.from(payload, (x) => {
    if (!Number.isInteger(x) || x < 0 || x > 0xff)
      throw new ProtocolError("payload must be bytes");
    return x;
  });
  if (body.length > MAX_PAYLOAD) throw new ProtocolError("payload too large");

  if (protocol === PROTOCOL.ninebot) {
    const len = body.length;
    const head = [len, BT_ID, target, command, argument];
    // Checksum covers LEN through the last payload byte - payload included.
    const ck = checksum16([...head, ...body]);
    return Uint8Array.from([
      ...FRAME_MAGIC.ninebot,
      ...head,
      ...body,
      ck & 0xff,
      (ck >> 8) & 0xff,
    ]);
  }
  if (protocol === PROTOCOL.legacy) {
    if (body.length > MAX_PAYLOAD - 2) throw new ProtocolError("payload too large");
    const len = body.length + 2;
    const head = [len, target, command, argument];
    const ck = checksum16([...head, ...body]);
    return Uint8Array.from([
      ...FRAME_MAGIC.legacy,
      ...head,
      ...body,
      ck & 0xff,
      (ck >> 8) & 0xff,
    ]);
  }
  throw new ProtocolError("unknown protocol");
}

/** Total wire length of a frame whose LEN byte is `len`. */
export function frameLength(protocol, len) {
  // protocol 2: 2 magic + 1 len + 4 fixed + len payload + 2 checksum
  // protocol 1: 2 magic + 1 len + 3 fixed + (len - 2) payload + 2 checksum
  return protocol === PROTOCOL.ninebot ? len + 9 : len + 6;
}

/**
 * Byte-stream reassembler.
 *
 * BLE fragments frames across notifications, so "one notification = one frame"
 * is never true. It also concatenates frames, and a failed checksum must not
 * throw the rest of the stream away - both are covered by the resync path.
 */
export class FrameParser {
  constructor(onPacket, { protocol = null } = {}) {
    this.onPacket = onPacket;
    this.forcedProtocol = protocol;
    this.buffer = [];
    this.rejected = 0;
  }

  reset() {
    this.buffer = [];
  }

  _protocolAt(index) {
    if (this.buffer.length < index + 2) return null;
    const a = this.buffer[index];
    const b = this.buffer[index + 1];
    if (a === FRAME_MAGIC.ninebot[0] && b === FRAME_MAGIC.ninebot[1])
      return PROTOCOL.ninebot;
    if (a === FRAME_MAGIC.legacy[0] && b === FRAME_MAGIC.legacy[1])
      return PROTOCOL.legacy;
    return null;
  }

  push(view) {
    const bytes =
      view instanceof DataView
        ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
        : new Uint8Array(view);
    for (const byte of bytes) this.buffer.push(byte);

    // A frame is at most 264 bytes; two frames of slack is plenty and keeps a
    // garbage stream from growing without bound.
    if (this.buffer.length > 1024) this.buffer = this.buffer.slice(-512);

    while (this.buffer.length >= 4) {
      const protocol = this.forcedProtocol ?? this._protocolAt(0);
      if (!protocol) {
        this.buffer.shift();
        continue;
      }
      const len = this.buffer[2];
      const total = frameLength(protocol, len);
      if (total < 7 || (protocol === PROTOCOL.legacy && len < 2)) {
        this.rejected++;
        this.buffer.shift();
        continue;
      }
      if (this.buffer.length < total) return;

      const frame = this.buffer.slice(0, total);
      // Checksum covers everything after the magic up to the checksum itself.
      const ck = checksum16(frame.slice(2, total - 2));
      if (ck !== (frame[total - 2] | (frame[total - 1] << 8))) {
        this.rejected++;
        this.buffer.shift(); // resync one byte at a time, never drop the stream
        continue;
      }
      this.buffer.splice(0, total);
      this.onPacket(
        protocol === PROTOCOL.ninebot
          ? {
              protocol,
              source: frame[3],
              target: frame[4],
              cmd: frame[5],
              reg: frame[6],
              data: frame.slice(7, total - 2),
            }
          : {
              protocol,
              target: frame[3],
              source: frame[3],
              cmd: frame[4],
              reg: frame[5],
              data: frame.slice(6, total - 2),
            },
      );
    }
  }
}

/** Encode a protocol-2 identity read: no payload, response arrives as 0x04. */
export function readRegister(target, register, length = 2) {
  return encodeFrame({
    target,
    command: CMD.READ,
    argument: register,
    payload: [length & 0xff, (length >> 8) & 0xff],
  });
}

/** Little-endian u32, used by IAP begin and verify payloads. */
export function u32le(value) {
  const n = value >>> 0;
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

/**
 * IAP v2 firmware checksum: 32-bit ring sum of every byte, bitwise inverted.
 * This is NOT CRC32 - the device only compares the inverted sum.
 */
export function iapChecksum(bytes) {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) >>> 0;
  return ~sum >>> 0;
}

/**
 * IAP block payload. Length must be a multiple of 8; the final block is
 * zero-padded, which is what the bootloader's FORM check expects.
 */
export function iapBlockPayload(block) {
  const remainder = block.length % 8;
  const out = Array.from(block);
  if (remainder !== 0) for (let i = 0; i < 8 - remainder; i++) out.push(0x00);
  return out;
}

export { ProtocolError };
