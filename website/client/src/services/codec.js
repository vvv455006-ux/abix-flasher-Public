/**
 * Compatibility adapter.
 *
 * The framing itself lives in ninebotProtocol.js - one implementation, so the
 * builder and the parser can never drift apart again. These exports keep the
 * existing call sites (`buildPacket`, `FrameParser`) working, but they now
 * speak protocol 2 (0x5A 0xA5), which is what every x3 vehicle uses.
 *
 * The old builder emitted 0x55 0xAA framing with protocol-1 LEN semantics
 * (payload + 2) while laying out the body like protocol 2. A device counts
 * that LEN byte, waits two more bytes that never arrive, and discards the
 * frame - which surfaced as "Bootloader acknowledgment timeout" on every
 * attempt and is the reason the flash could never complete.
 */
export {
  FrameParser,
  PROTOCOL,
  checksum16,
  encodeFrame,
  frameLength,
  iapBlockPayload,
  iapChecksum,
  readRegister,
  u32le,
} from "./ninebotProtocol.js";

import { PROTOCOL, encodeFrame } from "./ninebotProtocol.js";

/**
 * Build a protocol-2 frame.
 *
 * @param {number} target   board target (BOARD.BLE, BOARD.VCU, ...)
 * @param {number} command  CMD.*
 * @param {number} register ARG byte
 * @param {number[]} payload
 */
export function buildPacket(target, command, register, payload = []) {
  return encodeFrame({
    protocol: PROTOCOL.ninebot,
    target,
    command,
    argument: register,
    payload,
  });
}
