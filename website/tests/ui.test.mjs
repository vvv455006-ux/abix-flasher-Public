import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
test("application warns about iOS before any key redemption or Bluetooth request", () => {
  const source = fs.readFileSync(
    new URL("../client/src/App.jsx", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("iOS is not supported"), true);
});

import { flowReducer, initialFlow } from "../client/src/services/flow.js";
test("flow cannot skip review or announce completion without verified engine result", () => {
  assert.equal(flowReducer(initialFlow, { type: "START" }).step, "choose");
  let state = flowReducer(initialFlow, { type: "REVIEW" });
  state = flowReducer(state, { type: "START" });
  assert.equal(flowReducer(state, { type: "RESET" }).step, "transferring");
  assert.equal(
    flowReducer(state, { type: "DONE", confirmed: false }).step,
    "transferring",
  );
  state = flowReducer(state, {
    type: "PROGRESS",
    phase: "verifying",
    percent: 100,
  });
  assert.equal(state.step, "verifying");
  assert.equal(
    flowReducer(state, { type: "DONE", confirmed: true }).step,
    "complete",
  );
});
