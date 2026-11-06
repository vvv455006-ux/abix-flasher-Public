import {
  CMD,
  IAP_BLOCK_SIZE,
  IAP_ERROR,
  IAP_ERROR_MEANING,
  PROTOCOL,
  encodeFrame,
  iapBlockPayload,
  iapChecksum,
  u32le,
} from "./ninebotProtocol.js";
import { requireExactModel } from "./ninebotModel.js";

export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Errors carry a machine-readable code so the UI and the log can tell a
 * transport problem from a rejected image. That distinction is the whole
 * difference between "try again" and "stop, this image is wrong".
 */
export class FlashError extends Error {
  constructor(code, message, { retryable = false, cause } = {}) {
    super(message);
    this.name = "FlashError";
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/** Thrown by a transport when the link dropped; never retried in place. */
export function isDisconnect(error) {
  const text = String(error?.message ?? "");
  return (
    error?.code === "DISCONNECTED" ||
    /disconnect|not connected|gatt server is disconnected|gattserverdisconnected/i.test(
      text,
    )
  );
}

/** Web Bluetooth's "one GATT operation at a time" collision. */
export function isBusy(error) {
  return /already in progress/i.test(String(error?.message ?? ""));
}

export function validateTelemetry(identity, telemetry, firmware) {
  if (
    !["g3", "f3"].includes(identity?.model) ||
    identity.model !== firmware?.model ||
    !identity.deviceId
  )
    throw new FlashError(
      "MODEL_MISMATCH",
      "Exact model verification failed. Unknown or incompatible hardware refused.",
    );
  // No published x3 register map exists for pack voltage, so a display image
  // may run on an operator checklist instead: the values are asserted by a
  // person standing at the scooter, not measured over the wire. The range
  // checks stay - only the unavailable voltage reading is waived.
  const attested = telemetry?.attested === true;
  if (
    !Number.isFinite(telemetry?.batteryPercent) ||
    telemetry.batteryPercent < 30 ||
    telemetry.batteryPercent > 100 ||
    !Number.isFinite(telemetry?.speed) ||
    telemetry.speed !== 0 ||
    (!attested && (!Number.isFinite(telemetry?.voltage) || telemetry.voltage <= 0)) ||
    !Number.isFinite(telemetry?.readAt) ||
    Date.now() - telemetry.readAt > 5000 ||
    telemetry.readAt > Date.now() + 1000
  )
    throw new FlashError(
      "TELEMETRY_UNSAFE",
      "Live telemetry unavailable or unsafe. Flashing refused.",
    );
}

const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function iapError(code) {
  const name = IAP_ERROR[code] ?? `UNKNOWN_${code}`;
  return new FlashError(
    `IAP_${name}`,
    `Target rejected the image: ${name} (0x${code.toString(16).padStart(2, "0")}) - ${IAP_ERROR_MEANING[name] ?? "no documented meaning"}.`,
  );
}

/**
 * Deterministic flash state machine.
 *
 * Sequence, per the documented IAP flow:
 *   0x07 begin   payload = u32le(total length)
 *   0x08 block   ARG = block index (& 0xff), payload = image bytes, len % 8 == 0
 *   0x09 verify  payload = u32le(~sum32 of the whole image)
 *   0x0A reset   no reply expected; the link usually drops here
 * then reconnect and read the installed version back.
 *
 * Differences from the previous implementation, each of which caused a real
 * abort on hardware:
 *   - begin carries the image length (was [0, 0]);
 *   - blocks are addressed by ARG, not by two index bytes inside the payload;
 *   - the final block is padded to a multiple of 8 (0x07 FORM otherwise);
 *   - 0x09 verify and 0x0A reset exist at all (was a second 0x07);
 *   - an IAP BUSY reply resends the same index instead of aborting;
 *   - any other error reply is decoded instead of being reported as a timeout;
 *   - a disconnect is never retried as if it were a lost acknowledgment.
 */
export class FlashEngine {
  busy = false;

  async run({
    bytes,
    firmware,
    profile,
    transport,
    signal,
    onProgress = () => {},
  }) {
    if (this.busy)
      throw new FlashError("BUSY", "A flash attempt is already active");
    if (
      !profile ||
      !(profile.qualified || profile.simulated) ||
      !!profile.simulated !== !!transport.isSimulator ||
      profile.model !== firmware.model ||
      ![
        "readIdentity",
        "readTelemetry",
        "verifyInstalled",
      ].every((k) => typeof profile[k] === "function")
    )
      throw new Error(
        "No qualified transport/profile; hardware testing required",
      );

    const blockSize = profile.blockSize ?? IAP_BLOCK_SIZE;
    const protocol = profile.protocol ?? PROTOCOL.ninebot;
    const target = profile.target;
    if (!Number.isInteger(target))
      throw new FlashError("PROFILE_INVALID", "Profile has no board target");

    const ackCode =
      profile.ackCode ?? ((p) => (p.cmd === CMD.IAP_ACK ? p.reg : null));
    const beginTimeout = profile.beginTimeoutMs ?? 9000;
    const blockTimeout = profile.blockTimeoutMs ?? 6000;
    const verifyTimeout = profile.verifyTimeoutMs ?? 8000;
    const busyLimit = profile.busyRetries ?? 40;

    this.busy = true;
    let wake;
    try {
      signal?.throwIfAborted();

      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length < 1 ||
        bytes.length > 4 * 1024 * 1024 ||
        (await sha256(bytes)) !== firmware.sha256
      )
        throw new FlashError(
          "DIGEST_MISMATCH",
          "Firmware digest verification failed",
        );

      const identity = await profile.readIdentity(transport, signal);
      // Hard gate. Unknown, conflicting or single-source identity never passes.
      requireExactModel(identity, firmware);
      const telemetry = await profile.readTelemetry(transport, signal);
      validateTelemetry(identity, telemetry, firmware);

      try {
        if (!transport.isSimulator && globalThis.navigator?.wakeLock)
          wake = await navigator.wakeLock.request("screen");
      } catch {
        /* optional power-management aid, not a safety claim */
      }

      // ---- 0x07 IAP begin -------------------------------------------------
      onProgress({ phase: "entering", percent: 0 });
      await this._expectAck({
        packet: encodeFrame({
          protocol,
          target,
          command: CMD.IAP_BEGIN,
          argument: 0,
          payload: u32le(bytes.length),
        }),
        transport,
        ackCode,
        signal,
        timeoutMs: beginTimeout,
        code: "IAP_BEGIN",
      });

      // ---- 0x08 blocks ----------------------------------------------------
      const total = Math.ceil(bytes.length / blockSize);
      for (let i = 0; i < total; i++) {
        signal?.throwIfAborted();
        const block = bytes.slice(i * blockSize, (i + 1) * blockSize);
        const packet = encodeFrame({
          protocol,
          target,
          command: CMD.IAP_BLOCK,
          argument: i & 0xff,
          payload: iapBlockPayload(block),
        });

        let transportAttempts = 0;
        let busyReplies = 0;
        for (;;) {
          try {
            await this._expectAck({
              packet,
              transport,
              ackCode,
              signal,
              timeoutMs: blockTimeout,
              code: "IAP_BLOCK",
            });
            break;
          } catch (err) {
            if (signal?.aborted) throw signal.reason ?? err;
            // BUSY means "flash is being written" - resend the same index.
            if (err.code === "IAP_BUSY") {
              if (busyReplies > busyLimit)
                throw new FlashError(
                  "IAP_BUSY",
                  `Target stayed busy for block ${i}; aborting rather than replaying a stale index.`,
                );
              busyReplies++;
              await delay(15, signal);
              continue;
            }
            if (isDisconnect(err)) throw err;
            const retryable =
              err.code === "ACK_TIMEOUT" ||
              err.retryable === true ||
              isBusy(err);
            if (
              !retryable ||
              profile.supportsBlockRetry !== true ||
              ++transportAttempts >= 3
            )
              throw err;
            // Same index, byte-identical payload, after the link settles.
            if (isBusy(err)) await delay(250 * transportAttempts, signal);
          }
        }

        onProgress({
          phase: "transferring",
          percent: Math.round(((i + 1) / total) * 100),
          current: i + 1,
          total,
        });
      }

      // ---- 0x09 verify ----------------------------------------------------
      onProgress({ phase: "verifying", percent: 100, current: total, total });
      await this._expectAck({
        packet: encodeFrame({
          protocol,
          target,
          command: CMD.IAP_VERIFY,
          argument: 0,
          payload: u32le(iapChecksum(bytes)),
        }),
        transport,
        ackCode,
        signal,
        timeoutMs: verifyTimeout,
        code: "IAP_VERIFY",
      });

      // ---- 0x0A reset -----------------------------------------------------
      // No acknowledgment exists for this opcode; newer tools fire it 3-4x.
      // A disconnect here is expected - the BLE module hard-reboots.
      onProgress({ phase: "rebooting", percent: 100, current: total, total });
      if (profile.resetAfterVerify !== false) {
        for (let i = 0; i < 3; i++) {
          try {
            await transport.write(
              encodeFrame({
                protocol,
                target,
                command: CMD.MCU_RESET,
                argument: 0,
                payload: [],
              }),
            );
          } catch (err) {
            if (!isDisconnect(err)) throw err;
            break;
          }
          await delay(profile.resetSpacingMs ?? 100, signal);
        }
      }

      const result = await profile.verifyInstalled(transport, {
        signal,
        expectedDigest: firmware.sha256,
        expectedModel: firmware.model,
      });
      // A display bootloader acknowledges the image (0x09) and reboots; it has
      // no command that hands a digest back. `sha256` is therefore checked when
      // the profile can supply one, and the confirmation itself is always
      // required. `evidence` says what was actually proven.
      if (
        result?.confirmed !== true ||
        result.model !== firmware.model ||
        (result.sha256 != null && result.sha256 !== firmware.sha256)
      )
        throw new FlashError(
          "VERIFY_FAILED",
          "Installed firmware verification failed. Success has NOT been confirmed.",
        );

      signal?.throwIfAborted();
      onProgress({ phase: "confirmed", percent: 100, current: total, total });
      return {
        confirmed: true,
        model: result.model,
        sha256: result.sha256 ?? null,
        evidence: result.evidence ?? "target-ack",
        simulated: transport.isSimulator,
        blocks: total,
      };
    } catch (error) {
      // A dropped link after the image was accepted is a normal reboot, not a
      // flash failure - but it is still not a confirmed success.
      if (isDisconnect(error) && !(error instanceof FlashError))
        throw new FlashError(
          "DISCONNECTED",
          "Bluetooth link disconnected during the transfer. The transfer was not confirmed; reconnect and re-read the version before retrying.",
          { cause: error },
        );
      throw error;
    } finally {
      try {
        await wake?.release();
      } catch {}
      await transport.disconnect();
      this.busy = false;
    }
  }

  /**
   * Send one packet and resolve on the matching IAP acknowledgment.
   * BUSY is surfaced as its own retryable code; every other non-zero result
   * becomes a decoded IAP error.
   */
  async _expectAck({
    packet,
    transport,
    ackCode,
    signal,
    timeoutMs,
    code,
  }) {
    let response;
    try {
      response = await transport.transact(
        packet,
        (p) => ackCode(p) !== null,
        { signal, timeoutMs },
      );
    } catch (error) {
      if (isDisconnect(error) || signal?.aborted) throw error;
      if (error?.code === "ACK_TIMEOUT")
        throw new FlashError(
          "ACK_TIMEOUT",
          `${code}: no acknowledgment within ${timeoutMs} ms.`,
          { retryable: true, cause: error },
        );
      throw error;
    }
    const result = ackCode(response);
    if (result === 0) return response;
    if (result === 0x06)
      throw new FlashError("IAP_BUSY", "Target flash busy", { retryable: true });
    throw iapError(result);
  }
}
