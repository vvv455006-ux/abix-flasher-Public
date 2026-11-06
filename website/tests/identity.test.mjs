import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD,
  CMD,
  FrameParser,
  PROTOCOL,
  checksum16,
  encodeFrame,
  frameLength,
  iapBlockPayload,
  iapChecksum,
  u32le,
} from "../client/src/services/ninebotProtocol.js";
import {
  IDENTITY_STATUS,
  assertManifestForModel,
  identifyDevice,
  modelForFirmwareId,
  modelFromSerial,
  modelFromVcuBanner,
  requireExactModel,
} from "../client/src/services/ninebotModel.js";
import { FlashEngine, sha256 } from "../client/src/services/flashEngine.js";
import { buildPacket } from "../client/src/services/codec.js";

/* ------------------------------------------------------------------ framing */

test("protocol-2 frame is 5A A5 with LEN = payload length and total = LEN + 9", () => {
  const frame = buildPacket(BOARD.BLE, CMD.READ, 0x10, [0x0e, 0x00]);
  assert.deepEqual([...frame.slice(0, 2)], [0x5a, 0xa5]);
  assert.equal(frame[2], 2, "LEN counts payload only");
  assert.equal(frame.length, frameLength(PROTOCOL.ninebot, frame[2]));
  assert.equal(frame[3], 0x3e, "BT_ID / app address comes first");
  assert.equal(frame[4], BOARD.BLE, "TARGET_ID follows BT_ID");
});

test("address order is app first, board second", () => {
  // The documented read-serial frame is `5A A5 02 3E 20 01 10 0E 00 ...`:
  // 0x3E (app / BT_ID) then 0x20 (board). The original builder emitted
  // `55 AA 03 20 3E ...` - legacy magic, legacy LEN, addresses reversed.
  const frame = buildPacket(0x20, CMD.READ, 0x10, [0x0e, 0x00]);
  assert.deepEqual([...frame.slice(0, 7)], [0x5a, 0xa5, 0x02, 0x3e, 0x20, 0x01, 0x10]);
  // Checksum follows the decompiled firmware (`~sum16`, mvn+uxth), which makes
  // this 0x80 0xFF. The 0x7C 0xFF quoted in the protocol doc disagrees with its
  // own arithmetic (`~0x7F` is 0xFF80), so the firmware wins.
  assert.deepEqual([...frame.slice(-2)], [0x80, 0xff]);
});

test("checksum is ~sum16 over LEN..last payload byte (golden vector)", () => {
  const frame = buildPacket(BOARD.BLE, CMD.READ, 0x10, [0x0e, 0x00]);
  // 0x02+0x04+0x3E+0x01+0x10+0x0E+0x00 = 0x63  ->  ~0x63 = 0xFF9C
  assert.equal(frame.at(-2), 0x9c);
  assert.equal(frame.at(-1), 0xff);
  assert.equal(checksum16([0x02, 0x04, 0x3e, 0x01, 0x10, 0x0e, 0x00]), 0xff9c);
});

test("large payloads do not overflow the checksum", () => {
  // A maximum-size frame whose byte sum exceeds 0xffff: the old
  // `sum ^ 0xffff` truncated to 16 bits and produced the wrong checksum here.
  const payload = new Array(255).fill(0xff);
  const head = [255, 0x3e, 0xff, 0xff, 0xff];
  const plain = [...head, ...payload].reduce((a, b) => a + b, 0);
  assert.ok(plain > 0xffff, "vector must exceed 16 bits");

  const frame = buildPacket(0xff, 0xff, 0xff, payload);
  assert.equal(frame.at(-2) | (frame.at(-1) << 8), checksum16([...head, ...payload]));
  assert.notEqual(checksum16([...head, ...payload]), plain ^ 0xffff);
});

test("parser reassembles a frame split across three notifications", () => {
  const out = [];
  const parser = new FrameParser((p) => out.push(p));
  const frame = encodeFrame({
    target: BOARD.VCU,
    command: CMD.IAP_ACK,
    argument: 0,
    payload: [0],
  });
  parser.push(frame.slice(0, 3));
  parser.push(frame.slice(3, 7));
  assert.equal(out.length, 0);
  parser.push(frame.slice(7));
  assert.equal(out.length, 1);
  assert.equal(out[0].cmd, CMD.IAP_ACK);
  assert.equal(out[0].reg, 0);
});

/* ----------------------------------------------------------------- identity */

test("serial prefix decides the model, and only for known prefixes", () => {
  assert.equal(modelFromSerial("1CG00000000001").model, "g3");
  assert.equal(modelFromSerial("1EF00000000001").model, "f3");
  assert.equal(modelFromSerial("1K100000000001").model, null, "ZT3 is not G3");
  assert.equal(modelFromSerial("").model, null);
});

test("VCU banner decides the model and the shared MCU banner never does", () => {
  assert.equal(modelFromVcuBanner("SCOOTER_VCU_xxG3").model, "g3");
  assert.equal(modelFromVcuBanner("SCOOTER_VCU_xxF3").model, "f3");
  assert.equal(modelFromVcuBanner("SCOOTER_MCU_0001").model, null);
});

test("a BLE name alone can never become a model", () => {
  const identity = identifyDevice({ bleName: "NB-MK046J2345" });
  assert.equal(identity.status, IDENTITY_STATUS.UNKNOWN);
  assert.equal(identity.model, null);
});

test("one source is provisional, two agreeing sources are verified", () => {
  const single = identifyDevice({ serial: "1CG00000000001" });
  assert.equal(single.status, IDENTITY_STATUS.PROVISIONAL);
  assert.equal(single.model, "g3");

  const doubled = identifyDevice({
    serial: "1CG00000000001",
    vcuBanner: "SCOOTER_VCU_xxG3",
  });
  assert.equal(doubled.status, IDENTITY_STATUS.VERIFIED);
  assert.equal(doubled.model, "g3");
});

test("conflicting evidence is a hard conflict, not a majority vote", () => {
  const identity = identifyDevice({
    serial: "1CG00000000001", // says G3
    vcuBanner: "SCOOTER_VCU_xxF3", // says F3
  });
  assert.equal(identity.status, IDENTITY_STATUS.CONFLICT);
  assert.equal(identity.model, null);
  assert.match(identity.notes.join(" "), /conflicting readings/);
});

test("an x3 family member that is not G3/F3 is refused by name", () => {
  const identity = identifyDevice({ hardwareId: 256 });
  assert.equal(identity.status, IDENTITY_STATUS.FOREIGN);
  assert.equal(identity.model, null);
});

test("firmware ids map through the registry and never default to F3", () => {
  assert.equal(modelForFirmwareId("g3_smoke"), "g3");
  assert.equal(modelForFirmwareId("g3_blackwave"), "g3");
  assert.equal(modelForFirmwareId("f3_smoke"), "f3");
  assert.equal(modelForFirmwareId("f3_display"), "f3");
  // The old `startsWith("g3") ? "g3" : "f3"` turned every one of these into F3.
  for (const id of ["G3_SMOKE", "g3", " stone_island ", "", "unknown_mod"])
    assert.equal(modelForFirmwareId(id), null, `${id} must not map`);
});

test("requireExactModel refuses unknown, provisional, conflicting and mismatched", () => {
  const verified = { status: IDENTITY_STATUS.VERIFIED, model: "g3" };
  const firmware = { model: "g3", id: "g3_smoke" };
  assert.equal(requireExactModel(verified, firmware), true);

  assert.throws(
    () => requireExactModel({ status: IDENTITY_STATUS.PROVISIONAL, model: "g3" }, firmware),
    /provisional/,
  );
  assert.throws(
    () => requireExactModel({ status: IDENTITY_STATUS.CONFLICT, model: null }, firmware),
    /conflict/i,
  );
  assert.throws(
    () => requireExactModel({ status: IDENTITY_STATUS.UNKNOWN, model: null }, firmware),
    /could not be proven/,
  );
  assert.throws(
    () => requireExactModel({ status: IDENTITY_STATUS.VERIFIED, model: "f3" }, firmware),
    /Model mismatch/,
  );
  // Right model, wrong registry entry.
  assert.throws(
    () => requireExactModel(verified, { model: "g3", id: "f3_smoke" }),
    /not registered for G3/,
  );
});

test("a manifest that does not enforce its model is rejected", () => {
  const manifest = (over) => ({
    firmware: {
      model: "f3",
      type: "BLE",
      enforceModel: true,
      compatible: ["f3_BLE"],
      ...over,
    },
  });
  assert.equal(assertManifestForModel(manifest(), "f3"), true);
  assert.throws(() => assertManifestForModel(manifest(), "g3"), /does not match/);
  assert.throws(
    () => assertManifestForModel(manifest({ enforceModel: false }), "f3"),
    /does not enforce/,
  );
  assert.throws(
    () => assertManifestForModel(manifest({ compatible: ["g3_BLE"] }), "f3"),
    /not marked compatible/,
  );
  assert.throws(
    () => assertManifestForModel(manifest({ type: "VCU" }), "f3"),
    /not a BLE display image/,
  );
});

/* --------------------------------------------------------------- IAP engine */

function makeTransport(ackFor) {
  const sent = [];
  return {
    isSimulator: true,
    sent,
    packets: () => sent.map((p) => [...p]),
    async write(packet) {
      sent.push(packet);
    },
    async transact(packet, match) {
      sent.push(packet);
      const response = {
        protocol: PROTOCOL.ninebot,
        cmd: CMD.IAP_ACK,
        reg: ackFor(packet, sent),
        data: [0],
      };
      if (!match(response)) throw new Error("ack matcher rejected the reply");
      return response;
    },
    async disconnect() {},
  };
}

async function runEngine({ bytes, ackFor = () => 0, identity, model = "g3", sent }) {
  const hash = await sha256(bytes);
  const transport = makeTransport(ackFor);
  const profile = {
    simulated: true,
    model,
    protocol: PROTOCOL.ninebot,
    target: BOARD.BLE,
    blockSize: 128,
    supportsBlockRetry: true,
    resetSpacingMs: 0,
    readIdentity: () => identity ?? {
      status: IDENTITY_STATUS.VERIFIED,
      model,
      deviceId: "fixture",
      canonicalName: "Ninebot " + model.toUpperCase(),
      sources: ["serial", "vcu-banner"],
    },
    readTelemetry: () => ({
      batteryPercent: 80,
      voltage: 40,
      speed: 0,
      readAt: Date.now(),
    }),
    verifyInstalled: async () => ({ confirmed: true, model, sha256: hash }),
  };
  const result = await new FlashEngine().run({
    bytes,
    firmware: { model, sha256: hash },
    profile,
    transport,
  });
  if (sent) sent.push(...transport.packets());
  return result;
}

test("IAP sequence: begin carries the length, blocks carry the index in ARG, verify carries ~sum32", async () => {
  const bytes = Uint8Array.from({ length: 130 }, (_, i) => i & 0xff);
  const sent = [];
  const result = await runEngine({ bytes, sent });
  assert.equal(result.confirmed, true);

  const begin = sent.find((p) => p[5] === CMD.IAP_BEGIN);
  assert.deepEqual([...begin.slice(7, -2)], u32le(bytes.length));

  const blocks = sent.filter((p) => p[5] === CMD.IAP_BLOCK);
  assert.equal(blocks.length, 2, "130 bytes -> one full block plus a tail");
  assert.equal(blocks[0][6], 0, "first block index in ARG");
  assert.equal(blocks[1][6], 1);
  // Tail block is 2 bytes, padded to a multiple of 8 (0x07 FORM otherwise).
  assert.equal(blocks[1][2], 8);
  assert.deepEqual([...blocks[1].slice(7, -2)], [128, 129, 0, 0, 0, 0, 0, 0]);

  const verify = sent.find((p) => p[5] === CMD.IAP_VERIFY);
  assert.deepEqual([...verify.slice(7, -2)], u32le(iapChecksum(bytes)));

  const resets = sent.filter((p) => p[5] === CMD.MCU_RESET);
  assert.equal(resets.length, 3, "reset is fire-and-forget, sent three times");
});

test("a rejected image is decoded, not reported as a timeout", async () => {
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
  await assert.rejects(
    runEngine({ bytes, ackFor: (p) => (p[5] === CMD.IAP_BLOCK ? 0x07 : 0) }),
    (error) => {
      assert.equal(error.code, "IAP_FORM");
      assert.match(error.message, /data format/i);
      return true;
    },
  );
});

test("IAP BUSY resends the same block index instead of aborting", async () => {
  const bytes = Uint8Array.from({ length: 128 }, (_, i) => i);
  let busy = 2;
  const sent = [];
  await runEngine({
    bytes,
    sent,
    ackFor: (p) => {
      if (p[5] !== CMD.IAP_BLOCK) return 0;
      if (busy-- > 0) return 0x06;
      return 0;
    },
  });
  const blocks = sent.filter((p) => p[5] === CMD.IAP_BLOCK);
  assert.equal(blocks.length, 3, "two BUSY replies plus one accepted block");
  for (const block of blocks) assert.equal(block[6], 0, "index never advanced");
});

test("a disconnect is never retried as a lost acknowledgment", async () => {
  const bytes = Uint8Array.from({ length: 128 }, (_, i) => i);
  let attempts = 0;
  await assert.rejects(
    runEngine({
      bytes,
      ackFor: (p) => {
        if (p[5] === CMD.IAP_BLOCK) {
          attempts++;
          const error = new Error("Simulated Bluetooth disconnect");
          error.code = "DISCONNECTED";
          throw error;
        }
        return 0;
      },
    }),
    /disconnect/i,
  );
  assert.equal(attempts, 1, "one attempt only");
});

test("the engine refuses a provisional identity before sending anything", async () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
  const result = runEngine({
    bytes,
    identity: { status: IDENTITY_STATUS.PROVISIONAL, model: "g3" },
  });
  await assert.rejects(result, /provisional/);
});

test("iapBlockPayload always returns a multiple of eight", () => {
  for (const size of [0, 1, 2, 7, 8, 127, 128]) {
    const out = iapBlockPayload(Uint8Array.from({ length: size }, () => 1));
    assert.equal(out.length % 8, 0, `size ${size}`);
  }
});
