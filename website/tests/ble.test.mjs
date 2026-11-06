import test from "node:test";
import assert from "node:assert/strict";
import {
  NinebotBleService,
  identifyModel,
} from "../client/src/services/ninebotBleService.js";
test("UART parser consumes the full frame including both checksum bytes", () => {
  const service = new NinebotBleService();
  const received = [];
  service.onNotificationCallback = (p) => received.push(p);
  const packet = NinebotBleService.buildPacket(0x20, 1, 0x10, [1, 2, 3]);
  service.processIncomingBytes(new DataView(packet.buffer));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].data, [1, 2, 3]);
});
test("model inference never treats unknown devices or G30 as G3", () => {
  assert.equal(identifyModel({ deviceName: "G30" }).modelCode, "unknown");
  assert.equal(identifyModel({}).modelCode, "unknown");
  assert.equal(identifyModel({ rawModelCode: "G3" }).modelCode, "g3");
  assert.equal(identifyModel({ rawModelCode: "F3" }).modelCode, "f3");
});

import { FrameParser, buildPacket } from "../client/src/services/codec.js";
import {
  validateTelemetry,
  FlashEngine,
} from "../client/src/services/flashEngine.js";
test("fragmented and concatenated frames recover after invalid checksum/noise", () => {
  const packets = [];
  const p = new FrameParser((x) => packets.push(x));
  const good = buildPacket(0x20, 8, 0, [1, 2, 3]);
  const bad = good.slice();
  bad[bad.length - 1] ^= 1;
  p.push(new Uint8Array([0, 0x55, 0, 0, ...bad, ...good.slice(0, 5)]));
  assert.equal(packets.length, 0);
  p.push(new Uint8Array([...good.slice(5), ...good]));
  assert.equal(packets.length, 2);
});
test("missing/stale telemetry and cross-model images fail closed", () => {
  const identity = { model: "g3", deviceId: "fixture" };
  const good = {
    batteryPercent: 80,
    voltage: 40,
    speed: 0,
    readAt: Date.now(),
  };
  assert.doesNotThrow(() => validateTelemetry(identity, good, { model: "g3" }));
  for (const t of [
    { ...good, batteryPercent: null },
    { ...good, speed: NaN },
    { ...good, readAt: Date.now() - 10000 },
    { ...good, batteryPercent: 29 },
  ])
    assert.throws(() => validateTelemetry(identity, t, { model: "g3" }));
  assert.throws(() => validateTelemetry(identity, good, { model: "f3" }));
  assert.throws(() =>
    validateTelemetry({ model: "unknown" }, good, { model: "g3" }),
  );
});
test("no real transport can run under a simulation-only or unqualified hardware profile", async () => {
  await assert.rejects(
    new FlashEngine().run({
      bytes: new Uint8Array([1]),
      firmware: { model: "g3" },
      profile: { model: "g3", simulated: true },
      transport: { isSimulator: false },
    }),
    /qualified/,
  );
});
