import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import {
  BLE_BOARD,
  ENC2_CMD,
  FW_DATA,
  decryptFrame,
  deriveKey,
  encryptFrame,
  plainFrame,
  readPlainFrame,
} from "../client/src/services/enc2.js";
import { Enc2Session } from "../client/src/services/enc2Session.js";
import { Enc2Link } from "../client/src/services/enc2Link.js";
import { FlashEngine } from "../client/src/services/flashEngine.js";
import { CMD, encodeFrame, iapBlockPayload, iapChecksum, u32le } from "../client/src/services/ninebotProtocol.js";

globalThis.crypto ??= webcrypto;

const SERIAL = "1EFABC12345678";
const AUTH = Uint8Array.from({ length: 16 }, (_, i) => (i * 7 + 3) & 0xff);
const NAME = SERIAL;

function ascii(text) {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
}

/**
 * A device that speaks the documented enc2 handshake and IAP acknowledgments.
 * It exists to prove the client's frame order, counters and block accounting;
 * it is not evidence that real firmware accepts these frames.
 */
class Device {
  constructor({ blockSize = 128, busyEvery = 0 } = {}) {
    this.blockSize = blockSize;
    this.busyEvery = busyEvery;
    this.auth = AUTH;
    this.password = null;
    this.authenticated = false;
    this.tx = 1;
    this.lastRx = -1;
    this.blocks = [];
    this.resetCount = 0;
    this.verifyChecksum = null;
    this.beginLength = null;
    this.busySent = 0;
    this.frames = [];
  }

  async receive(wire) {
    const counter = (wire[wire.length - 2] << 8) | wire[wire.length - 1];
    const preKey = await deriveKey(NAME, FW_DATA);
    const namedKey = await deriveKey(NAME, this.auth);
    const sessionKey = this.password ? await deriveKey(this.password, this.auth) : namedKey;

    const decoded =
      counter === 0
        ? await decryptFrame({ key: preKey, authParam: null, frame: wire, ecbInput: FW_DATA })
        : await decryptFrame({ key: sessionKey, authParam: this.auth, frame: wire });
    if (!decoded.ok) return null;
    const packet = readPlainFrame(decoded.plaintext);
    this.frames.push({ cmd: packet.cmd, reg: packet.reg, counter, len: packet.data.length });

    if (counter > 0) {
      if (counter <= this.lastRx) return null;
      this.lastRx = counter;
    }

    const reply = (cmd, index, data, replyKey) =>
      encryptFrame({
        key: replyKey,
        counter: ++this.tx,
        authParam: this.auth,
        plaintext: plainFrame(BLE_BOARD, cmd, index, data),
      });

    if (packet.cmd === ENC2_CMD.PRE_COMM) {
      const payload = new Uint8Array(30);
      payload.set(this.auth, 0);
      payload.set(ascii(SERIAL), 16);
      return encryptFrame({
        key: preKey,
        counter: 0,
        authParam: null,
        plaintext: plainFrame(BLE_BOARD, ENC2_CMD.PRE_COMM, this.password ? 1 : 0, payload),
      });
    }

    if (packet.cmd === ENC2_CMD.SET_PWD) {
      this.password = Uint8Array.from(packet.data.subarray(0, 16));
      return reply(ENC2_CMD.SET_PWD, 1, [], namedKey);
    }

    if (packet.cmd === ENC2_CMD.AUTH) {
      const matches =
        this.password &&
        String.fromCharCode(...packet.data) === SERIAL &&
        counter >= 2;
      this.authenticated = !!matches;
      return reply(ENC2_CMD.AUTH, matches ? 1 : 0, [], sessionKey);
    }

    if (!this.authenticated) return null;

    if (packet.cmd === CMD.IAP_BEGIN) {
      this.beginLength =
        (packet.data[0] |
          (packet.data[1] << 8) |
          (packet.data[2] << 16) |
          (packet.data[3] << 24)) >>>
        0;
      return reply(CMD.IAP_ACK, 0, [], sessionKey);
    }

    if (packet.cmd === CMD.IAP_BLOCK) {
      if (this.busyEvery && this.blocks.length % this.busyEvery === 0 && this.busySent < 3 + this.blocks.length) {
        this.busySent++;
        return reply(CMD.IAP_ACK, 0x06, [], sessionKey);
      }
      this.blocks.push({ index: packet.reg, data: Uint8Array.from(packet.data) });
      return reply(CMD.IAP_ACK, 0, [], sessionKey);
    }

    if (packet.cmd === CMD.IAP_VERIFY) {
      this.verifyChecksum =
        (packet.data[0] |
          (packet.data[1] << 8) |
          (packet.data[2] << 16) |
          (packet.data[3] << 24)) >>>
        0;
      return reply(CMD.IAP_ACK, 0, [], sessionKey);
    }

    if (packet.cmd === CMD.MCU_RESET) {
      this.resetCount++;
      return null;
    }
    return null;
  }
}

/** Link double: frames go straight to the device, replies come back async. */
class MemoryLink {
  constructor(device) {
    this.device = device;
    this.handler = null;
    this.sent = [];
  }
  onFrame(handler) {
    this.handler = handler;
  }
  async connect() {}
  async writeRaw(bytes) {
    this.sent.push(Uint8Array.from(bytes));
    const reply = await this.device.receive(bytes);
    if (reply) queueMicrotask(() => this.handler?.(reply));
  }
  async disconnect() {}
}

const file = readFileSync(new URL("../server/firmware_storage/f3_smoke/FIRM.bin.enc", import.meta.url));
const slice = file.subarray(0, 4096);
const digest = createHash("sha256").update(slice).digest("hex");

test("handshake runs PRE_COMM, SET_PWD and AUTH with counters 0, 2 and 3", async () => {
  const device = new Device();
  const link = new MemoryLink(device);
  const session = new Enc2Session(link, { timeoutMs: 2000 });
  const opened = await session.open({ name: NAME });
  assert.equal(opened.serial, SERIAL);
  assert.equal(opened.password.length, 16);
  const counters = device.frames.map((frame) => frame.counter);
  assert.deepEqual(counters, [0, 2, 3]);
  assert.deepEqual(
    device.frames.map((frame) => frame.cmd),
    [ENC2_CMD.PRE_COMM, ENC2_CMD.SET_PWD, ENC2_CMD.AUTH],
  );
  session.close();
});

test("a wrong session password fails AUTH instead of silently continuing", async () => {
  const device = new Device();
  device.password = Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i);
  const link = new MemoryLink(device);
  const session = new Enc2Session(link, { timeoutMs: 2000 });
  await assert.rejects(
    session.open({ name: NAME, password: Uint8Array.from({ length: 16 }, () => 0x11) }),
    /AUTH|No enc2 reply/,
  );
  session.close();
});

test("the engine flashes the real image through enc2 and only confirms on an ACK", async () => {
  const device = new Device();
  const link = new MemoryLink(device);
  const session = new Enc2Session(link, { timeoutMs: 2000 });
  await session.open({ name: NAME });

  const firmware = {
    id: "f3_smoke",
    model: "f3",
    sha256: digest,
    displayName: "StarCFW_v0.6_smoke_Abi_private_F3",
  };
  const phases = [];
  const transport = {
    isSimulator: false,
    write: (packet) => session.write(packet),
    transact: (packet, match, { timeoutMs } = {}) =>
      session.request(packet, { match, timeoutMs }),
    disconnect: async () => {},
  };
  const profile = {
    qualified: true,
    simulated: false,
    model: "f3",
    target: BLE_BOARD,
    blockSize: 128,
    supportsBlockRetry: true,
    beginTimeoutMs: 3000,
    blockTimeoutMs: 3000,
    verifyTimeoutMs: 3000,
    resetAfterVerify: true,
    readIdentity: async () => ({ model: "f3", status: "verified", deviceId: SERIAL, sources: ["serial", "hardware-id"] }),
    readTelemetry: async () => ({ batteryPercent: 72, speed: 0, readAt: Date.now(), attested: true }),
    verifyInstalled: async () => ({
      confirmed: true,
      model: "f3",
      sha256: null,
      evidence: "Ziel-ACK 0x09",
    }),
  };

  const result = await new FlashEngine().run({
    bytes: slice,
    firmware,
    profile,
    transport,
    onProgress: (event) => phases.push(event.phase),
  });

  const expectedBlocks = Math.ceil(slice.length / 128);
  assert.equal(result.confirmed, true);
  assert.equal(result.blocks, expectedBlocks);
  assert.equal(device.beginLength, slice.length);
  assert.equal(device.blocks.length, expectedBlocks);
  assert.equal(device.verifyChecksum, iapChecksum(slice) >>> 0);
  assert.equal(device.resetCount, 3);
  assert.ok(phases.includes("transferring"));
  assert.equal(phases.at(-1), "confirmed");

  // Every block carries its index and the final block is padded to 8 bytes.
  for (const [position, block] of device.blocks.entries()) {
    assert.equal(block.index, position & 0xff);
    assert.equal(block.data.length % 8, 0);
    const source = Uint8Array.from(slice.subarray(position * 128, (position + 1) * 128));
    assert.deepEqual(block.data.subarray(0, source.length), source);
    if (source.length % 8 !== 0)
      assert.deepEqual(block.data.subarray(source.length), new Uint8Array(8 - (source.length % 8)));
  }
  assert.deepEqual(
    device.blocks.at(-1).data,
    Uint8Array.from(iapBlockPayload(slice.subarray(-(slice.length % 128 || 128)))),
  );
  session.close();
});

test("a BUSY ack resends the same block instead of aborting", async () => {
  const device = new Device({ busyEvery: 4 });
  const link = new MemoryLink(device);
  const session = new Enc2Session(link, { timeoutMs: 2000 });
  await session.open({ name: NAME });
  const small = file.subarray(0, 512);
  const transport = {
    isSimulator: false,
    write: (packet) => session.write(packet),
    transact: (packet, match, { timeoutMs } = {}) =>
      session.request(packet, { match, timeoutMs }),
    disconnect: async () => {},
  };
  const profile = {
    qualified: true,
    simulated: false,
    model: "f3",
    target: BLE_BOARD,
    blockSize: 128,
    supportsBlockRetry: true,
    beginTimeoutMs: 3000,
    blockTimeoutMs: 3000,
    verifyTimeoutMs: 3000,
    busyRetries: 200,
    readIdentity: async () => ({ model: "f3", status: "verified", deviceId: SERIAL, sources: ["serial"] }),
    readTelemetry: async () => ({ batteryPercent: 55, speed: 0, readAt: Date.now(), attested: true }),
    verifyInstalled: async () => ({ confirmed: true, model: "f3", sha256: null }),
  };
  const result = await new FlashEngine().run({
    bytes: small,
    firmware: { model: "f3", sha256: createHash("sha256").update(small).digest("hex") },
    profile,
    transport,
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.blocks, Math.ceil(small.length / 128));
  assert.ok(device.busySent > 0);
  session.close();
});

test("the wire link reassembles split notifications and never merges frames", async () => {
  const link = new Enc2Link({
    service: {
      connect: async () => {},
      write: async () => {},
      disconnect: async () => {},
    },
  });
  const frames = [];
  link.onFrame((frame) => frames.push(frame));
  await link.connect();

  const key = await deriveKey(NAME, AUTH);
  const one = await encryptFrame({
    key,
    counter: 2,
    authParam: AUTH,
    plaintext: plainFrame(BLE_BOARD, 0x01, 0, [0xaa]),
  });
  const two = await encryptFrame({
    key,
    counter: 3,
    authParam: AUTH,
    plaintext: plainFrame(BLE_BOARD, 0x02, 1, [0xbb]),
  });

  // A lone start byte is not a frame, and must not shift the next one.
  link._feed(Uint8Array.from([0x5a]));
  for (let i = 0; i < one.length; i += 7) link._feed(one.subarray(i, i + 7));
  // Two frames arriving in a single notification must not merge into one.
  link._feed(Uint8Array.from([...two, ...one]));

  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], one);
  assert.deepEqual(frames[1], two);
  assert.deepEqual(frames[2], one);
});

test("the whole 1.9 MB image crosses the 8-bit block index and lands intact", async () => {
  const device = new Device();
  const link = new MemoryLink(device);
  const session = new Enc2Session(link, { timeoutMs: 5000 });
  await session.open({ name: NAME });

  const transport = {
    isSimulator: false,
    write: (packet) => session.write(packet),
    transact: (packet, match, { timeoutMs } = {}) =>
      session.request(packet, { match, timeoutMs }),
    disconnect: async () => {},
  };
  const profile = {
    qualified: true,
    simulated: false,
    model: "f3",
    target: BLE_BOARD,
    blockSize: 128,
    supportsBlockRetry: true,
    beginTimeoutMs: 5000,
    blockTimeoutMs: 5000,
    verifyTimeoutMs: 5000,
    readIdentity: async () => ({ model: "f3", status: "verified", deviceId: SERIAL, sources: ["serial", "hardware-id"] }),
    readTelemetry: async () => ({ batteryPercent: 80, speed: 0, readAt: Date.now(), attested: true }),
    verifyInstalled: async () => ({ confirmed: true, model: "f3", sha256: null }),
  };

  const full = Uint8Array.from(file);
  const result = await new FlashEngine().run({
    bytes: full,
    firmware: { id: "f3_smoke", model: "f3", sha256: createHash("sha256").update(full).digest("hex") },
    profile,
    transport,
  });

  // Index arithmetic wraps at 256 by design, so the tail proves the last byte
  // of the image was addressed, not just the last block counter.
  assert.equal(result.confirmed, true);
  assert.equal(device.beginLength, full.length);
  assert.equal(device.blocks.length, 15538);
  assert.equal(device.blocks.at(-1).index, (15537 & 0xff));
  assert.equal(device.verifyChecksum, iapChecksum(full) >>> 0);
  for (const position of [0, 255, 256, 4095, 8192, 15537]) {
    const source = full.subarray(position * 128, (position + 1) * 128);
    assert.deepEqual(
      device.blocks[position].data.subarray(0, source.length),
      source,
      `block ${position} differs`,
    );
  }
  const tail = full.subarray(-(full.length % 128));
  assert.deepEqual(device.blocks.at(-1).data, Uint8Array.from(iapBlockPayload(tail)));
  session.close();
});

test("the real image block plan matches 128-byte IAP blocks", () => {
  const blocks = Math.ceil(file.length / 128);
  assert.equal(blocks, Math.ceil(1988776 / 128));
  assert.equal(blocks, 15538);
  const tail = iapBlockPayload(file.subarray(-(file.length % 128)));
  assert.equal(tail.length % 8, 0);
  assert.equal(tail.length, 40);
  assert.equal(u32le(file.length).length, 4);
  assert.equal(encodeFrame({ target: BLE_BOARD, command: CMD.IAP_BEGIN, argument: 0, payload: u32le(file.length) }).length, 13);
  assert.ok(FW_DATA.length === 16);
});
