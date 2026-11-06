import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://studio.test/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { render, screen, cleanup, waitFor } =
  await import("@testing-library/react");
const { default: userEvent } = await import("@testing-library/user-event");
const { default: App } = await import("../src/App.jsx");
// A failing assertion must not leave its DOM (or its hash) behind.
afterEach(() => {
  cleanup();
  dom.window.location.hash = "";
});

const calls = [];
globalThis.fetch = async (path, options = {}) => {
  calls.push({ path, method: options.method || "GET" });
  return {
    ok: true,
    json: async () => ({ success: true, firmwares: [] }),
  };
};

test("the studio stays locked until a key is entered", async () => {
  calls.length = 0;
  const user = userEvent.setup({ document: dom.window.document });
  render(React.createElement(App));
  assert.ok(
    await screen.findByRole("heading", { name: "Enter your key." }),
  );
  assert.ok(screen.getByLabelText("Access key"));
  // Nothing behind the door is rendered, and nothing is fetched to get in.
  assert.equal(screen.queryByText(/Check your scooter/), null);
  assert.equal(screen.queryByText(/A clearer way/), null);

  await user.type(screen.getByLabelText("Access key"), "nonsense-key");
  await user.click(screen.getByRole("button", { name: /Unlock/ }));
  await waitFor(() =>
    assert.ok(screen.getByText("That is not a valid access key.")),
  );
  assert.equal(
    calls.filter((call) => call.method !== "GET").length,
    0,
  );
});

test("a forged key with the right shape is rejected", async () => {
  const user = userEvent.setup({ document: dom.window.document });
  render(React.createElement(App));
  await screen.findByRole("heading", { name: "Enter your key." });
  // 13 payload bytes + 64 signature bytes, all zero: well-formed, unsigned.
  const forged = "ABI1." + Buffer.alloc(77).toString("base64url");
  await user.type(screen.getByLabelText("Access key"), forged);
  await user.click(screen.getByRole("button", { name: /Unlock/ }));
  await waitFor(() =>
    assert.ok(screen.getByText("That is not a valid access key.")),
  );
  assert.equal(screen.queryByText(/Check your scooter/), null);
});

test("a direct #admin link still lands on the gate", async () => {
  dom.window.location.hash = "#admin";
  render(React.createElement(App));
  assert.ok(
    await screen.findByRole("heading", { name: "Enter your key." }),
  );
  assert.equal(screen.queryByRole("heading", { name: "ABI ADMIN" }), null);
  assert.equal(
    screen.queryByRole("button", { name: /Generate keys/ }),
    null,
  );
});

test("the F3 tab shows the two F3 templates by their brand names", async () => {
  const { default: FirmwarePanel } = await import(
    "../src/components/FirmwarePanel.jsx"
  );
  const user = userEvent.setup({ document: dom.window.document });
  render(React.createElement(FirmwarePanel, { catalog: [] }));
  assert.ok(await screen.findByRole("heading", { name: /Vorlagen/ }));
  const cards = dom.window.document.querySelectorAll(".fw-card");
  assert.equal(cards.length, 2);
  for (const card of cards) assert.match(card.textContent, /Ninebot F3/);
  assert.equal(screen.getAllByText("Under Armour").length, 1);
  assert.equal(screen.getAllByText("Stone Island").length, 1);

  await user.click(screen.getByRole("tab", { name: /MAX G3/ }));
  const g3Cards = dom.window.document.querySelectorAll(".fw-card");
  assert.equal(g3Cards.length, 2);
  for (const card of g3Cards) assert.match(card.textContent, /Ninebot MAX G3/);
  assert.equal(screen.getAllByText("Under Armour").length, 1);
});

test("picking a template asks for the physical checklist before any write", async () => {
  const { default: FirmwarePanel } = await import(
    "../src/components/FirmwarePanel.jsx"
  );
  const user = userEvent.setup({ document: dom.window.document });
  render(React.createElement(FirmwarePanel, { catalog: [] }));
  await screen.findByRole("heading", { name: /Vorlagen/ });
  const card = dom.window.document.querySelector(".fw-card");
  await user.click(card);
  const write = screen.getByRole("button", { name: /Auf Roller schreiben/ });
  assert.equal(write.disabled, true);
  await user.type(screen.getByLabelText(/Akkustand/), "64");
  assert.equal(write.disabled, true);
  await user.click(screen.getByLabelText(/Roller steht/));
  assert.equal(write.disabled, false);
});

test("ABI ADMIN asks for the master key and nothing else", async () => {
  const { default: AdminPortal } = await import(
    "../src/components/AdminPortal.jsx"
  );
  render(React.createElement(AdminPortal));
  assert.ok(await screen.findByRole("heading", { name: "ABI ADMIN" }));
  assert.ok(screen.getByLabelText("Master key"));
  assert.equal(
    screen.getByRole("button", { name: /Generate keys/ }).disabled,
    true,
  );
  assert.equal(screen.queryByText(/Check your scooter/), null);
});
