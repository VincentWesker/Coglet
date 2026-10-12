import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MotionConnection, setupMotion, validateCapabilities } from "./motion.js";

const capabilities = {
  service: "coglet-motion", version: 1, leaseMs: 5000, calibrating: false, mode: null,
  servos: [{ name: "PIT", socket: 8, min: 1, max: 80, target: 80 }],
  animations: ["listening", "sad"], actions: ["blink"],
};

function mockPort(respond = request => ({ ...capabilities, id: request.id, ok: true })) {
  const requests = [];
  let input;
  let closed = false;
  const port = {
    async open() {
      this.readable = new ReadableStream({ start(controller) { input = controller; } });
      this.writable = new WritableStream({
        write(bytes) {
          const text = new TextDecoder().decode(bytes);
          assert.ok(text.startsWith("diag:"));
          assert.ok(text.endsWith("\n"));
          const request = JSON.parse(text.slice(5));
          requests.push(request);
          const response = respond(request);
          if (response) input.enqueue(new TextEncoder().encode(`boot log\nCOGLET_DIAG ${JSON.stringify(response)}\r\n`));
        },
      });
    },
    async close() {
      assert.equal(this.readable.locked, false);
      assert.equal(this.writable.locked, false);
      closed = true;
    },
  };
  return { port, requests, get closed() { return closed; }, end: () => input.close() };
}

test("connection checks firmware without sending movement; concurrent writes release locks", async () => {
  const mock = mockPort();
  const statuses = [];
  const client = new MotionConnection(value => statuses.push(value), assert.fail);
  assert.equal((await client.open(mock.port)).servos[0].max, 80);
  assert.deepEqual(mock.requests.map(request => request.command), ["hello"]);
  await Promise.all([client.send("servo", { name: "PIT", angle: 40 }), client.send("stop")]);
  assert.deepEqual(mock.requests.map(request => request.id), [1, 2, 3]);
  assert.equal(statuses.length, 3);
  await client.close();
  assert.equal(mock.closed, true);
});

test("firmware rejection is surfaced, not treated as movement success", async () => {
  const mock = mockPort(request => request.command === "hello" ?
    { ...capabilities, id: request.id, ok: true } :
    { id: request.id, ok: false, error: "Calibration Mode owns the servos" });
  const client = new MotionConnection(() => {}, assert.fail);
  await client.open(mock.port);
  await assert.rejects(client.send("servo", { name: "PIT", angle: 90 }), /Calibration Mode/);
  await client.close();
});

test("wrong port or invalid capabilities close the port and never enable controls", async () => {
  const mock = mockPort(request => ({ id: request.id, ok: true, service: "other" }));
  const client = new MotionConnection(() => {}, assert.fail);
  await assert.rejects(client.open(mock.port), /compatible Coglet motion firmware/);
  assert.equal(mock.closed, true);
  for (const patch of [
    { servos: [{ ...capabilities.servos[0], min: NaN }] },
    { servos: [{ ...capabilities.servos[0], max: 181 }] },
    { servos: [capabilities.servos[0], capabilities.servos[0]] },
    { animations: ["<script>"] },
  ]) assert.throws(() => validateCapabilities({ ...capabilities, ...patch }));
});

test("disconnect rejects pending commands and reports loss of hardware connection", async () => {
  const mock = mockPort(request => request.command === "hello" ? { ...capabilities, id: request.id, ok: true } : null);
  let failure;
  const client = new MotionConnection(() => {}, error => { failure = error; });
  await client.open(mock.port);
  const pending = client.send("servo", { name: "PIT", angle: 40 });
  mock.end();
  await assert.rejects(pending, /USB disconnected/);
  await client.reading;
  assert.match(failure.message, /5-second heartbeat/);
  await client.close();
});

test("missing acknowledgement times out instead of claiming success", async t => {
  const mock = mockPort(request => request.command === "hello" ? { ...capabilities, id: request.id, ok: true } : null);
  const client = new MotionConnection(() => {}, assert.fail);
  await client.open(mock.port);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = client.send("stop");
  t.mock.timers.tick(2000);
  await assert.rejects(pending, /No acknowledgement/);
  await client.close();
});

test("a port already owned by the log viewer is never closed by motion setup", async () => {
  let closed = false;
  const port = {
    readable: {}, writable: {},
    async open() { throw new Error("Port already open"); },
    async close() { closed = true; },
  };
  const client = new MotionConnection(() => {}, assert.fail);
  await assert.rejects(client.open(port), /already open/);
  assert.equal(closed, false);
});

function motionFixture(t, respond) {
  class Element extends EventTarget {
    constructor() {
      super();
      this.value = "";
      this.checked = false;
      this.hidden = true;
      this.dataset = {};
      this.attributes = {};
      this.classList = { toggle() {} };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelector() { return (this.span ??= {}); }
    replaceChildren(...options) { this.value = options[0]?.value ?? ""; }
    checkValidity() {
      const angle = Number(this.value);
      return this.value !== "" && Number.isFinite(angle) &&
        angle >= Number(this.min) && angle <= Number(this.max) && Number.isInteger(angle);
    }
    reportValidity() { return this.checkValidity(); }
    click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  }
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const hotspots = ["PIT", "MOU", "EYL"].map(name => {
    const element = new Element();
    element.dataset.servo = name;
    return element;
  });
  $("servo-hotspots").querySelectorAll = () => hotspots;
  $("servo-step").value = "1";
  const data = { ...capabilities, servos: [
    capabilities.servos[0],
    { name: "MOU", socket: 3, min: 10, max: 30, target: 20 },
  ] };
  const mock = mockPort(request => request.command === "hello" ?
    { ...data, id: request.id, ok: true } :
    respond?.(request) ?? { id: request.id, ok: true, calibrating: false });
  const doc = Object.assign(new EventTarget(), { getElementById: $ });
  for (const [name, value] of Object.entries({
    document: doc,
    isSecureContext: true,
    navigator: { serial: { requestPort: async () => mock.port } },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  t.mock.method(globalThis, "setInterval", () => 0);
  const ui = setupMotion();
  const key = (keyName, options = {}) => {
    const event = new Event("keydown", { cancelable: true });
    for (const [name, value] of Object.entries({ key: keyName, ...options })) {
      Object.defineProperty(event, name, { value });
    }
    doc.dispatchEvent(event);
    return event;
  };
  return { $, hotspots, key, mock, ui };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("Motion UI did not settle.");
}

test("visual picker and immediate arrows preserve arming, limits and acknowledged targets", async t => {
  const { $, hotspots, mock } = motionFixture(t);
  assert.equal($("servo-decrease").disabled, true);
  assert.ok(hotspots.every(button => button.disabled));
  $("motion-connect").click();
  await until(() => !$("motion-arm").disabled);
  assert.deepEqual(mock.requests.map(request => request.command), ["hello"]);
  assert.equal(hotspots[2].disabled, true, "Unavailable servo stays disabled");
  hotspots[1].click();
  assert.equal($("servo-name").value, "MOU");
  assert.equal($("servo-selected").textContent, "Mouth");
  assert.equal(hotspots[1].attributes["aria-pressed"], "true");
  $("servo-increase").click();
  assert.equal(mock.requests.length, 1, "Selection and unarmed arrows send no motion");
  $("motion-arm").checked = true;
  $("motion-arm").dispatchEvent(new Event("change"));
  $("servo-increase").click();
  assert.equal($("servo-increase").disabled, true, "No repeated commands while awaiting acknowledgement");
  await until(() => !$("motion-arm").disabled);
  assert.deepEqual(mock.requests.at(-1), { id: 2, command: "servo", name: "MOU", angle: 21 });
  assert.equal($("servo-target").textContent, "21°");
  hotspots[0].click();
  assert.equal($("servo-increase").disabled, true, "Upper firmware limit disables increasing");
  $("servo-decrease").click();
  await until(() => !$("motion-arm").disabled);
  assert.equal(mock.requests.at(-1).angle, 79);
  hotspots[1].click();
  assert.equal($("servo-angle").value, 21, "Switching back retains the acknowledged target");
  $("servo-angle").value = "10";
  $("servo-angle").dispatchEvent(new Event("input"));
  assert.equal($("servo-decrease").disabled, true, "Lower firmware limit disables decreasing");
  $("servo-angle").value = "invalid";
  $("servo-angle").dispatchEvent(new Event("input"));
  assert.equal($("servo-increase").disabled, true, "Invalid angle cannot be jogged");
  $("coglet-image").dispatchEvent(new Event("error"));
  assert.equal($("servo-image-error").hidden, false);
  $("motion-disconnect").click();
  await until(() => mock.closed);
});

test("animation preview can be stopped from its controls", async t => {
  const { $, mock } = motionFixture(t);
  assert.equal($("animation-stop").disabled, true);
  $("motion-connect").click();
  await until(() => !$("motion-arm").disabled);
  $("motion-arm").checked = true;
  $("motion-arm").dispatchEvent(new Event("change"));
  assert.equal($("animation-stop").disabled, false);
  $("animation-name").value = "animation:sad";
  const play = new Event("submit", { cancelable: true });
  $("animation-form").dispatchEvent(play);
  assert.equal($("animation-play").disabled, true, "Play stays disabled while its command is pending");
  assert.equal($("animation-stop").disabled, false, "Stop remains available while a command is pending");
  await until(() => mock.requests.some(request => request.command === "animation"));
  $("animation-stop").click();
  await until(() => mock.requests.some(request => request.command === "stop") && !$("motion-arm").checked);
  assert.deepEqual(mock.requests.slice(1).map(({ command, name }) => ({ command, name })), [
    { command: "animation", name: "sad" },
    { command: "stop", name: undefined },
  ]);
  assert.match($("motion-notice").textContent, /PWM disabled/);
  $("motion-disconnect").click();
  await until(() => mock.closed);
});

test("an immediate arrow rejection disarms and closes motion without reporting a new target", async t => {
  const { $, mock, ui } = motionFixture(t, request => ({
    id: request.id, ok: false, error: "Calibration Mode owns the servos",
  }));
  $("motion-connect").click();
  await until(() => !$("motion-arm").disabled);
  $("motion-arm").checked = true;
  $("motion-arm").dispatchEvent(new Event("change"));
  $("servo-decrease").click();
  await until(() => !ui.connected);
  assert.equal(mock.closed, true);
  assert.equal($("motion-arm").checked, false);
  assert.equal($("servo-target").textContent, "80°");
  assert.match($("motion-notice").textContent, /Calibration Mode owns/);
  assert.equal($("servo-decrease").disabled, true);
});

test("Left/Right Arrow keys jog the selected servo only on the Motion tab outside fields", async t => {
  const { $, hotspots, key, mock } = motionFixture(t);
  $("motion-panel").hidden = false;
  $("motion-connect").click();
  await until(() => !$("motion-arm").disabled);
  hotspots[1].click();
  key("ArrowRight");
  assert.equal(mock.requests.length, 1, "Unarmed keys send no motion");
  $("motion-arm").checked = true;
  $("motion-arm").dispatchEvent(new Event("change"));
  assert.equal(key("ArrowRight").defaultPrevented, true);
  await until(() => !$("motion-arm").disabled);
  assert.deepEqual(mock.requests.at(-1), { id: 2, command: "servo", name: "MOU", angle: 21 });
  key("ArrowLeft", { repeat: true });
  key("ArrowLeft", { shiftKey: true });
  key("ArrowLeft", { target: { closest: () => ({}) } });
  $("motion-panel").hidden = true;
  key("ArrowLeft");
  assert.equal(mock.requests.length, 2, "Repeats, modifiers, fields and hidden tab are ignored");
  $("motion-panel").hidden = false;
  key("ArrowLeft");
  await until(() => !$("motion-arm").disabled);
  assert.equal(mock.requests.at(-1).angle, 20);
  $("motion-disconnect").click();
  await until(() => mock.closed);
});

test("selected step size drives arrows and labels, clamped to firmware limits", async t => {
  const { $, hotspots, mock } = motionFixture(t);
  assert.equal($("servo-increase").span.textContent, "+1°");
  $("servo-step").value = "5";
  $("servo-step").dispatchEvent(new Event("change"));
  assert.equal($("servo-decrease").span.textContent, "-5°");
  assert.equal($("servo-increase").attributes["aria-label"], "Increase servo target by 5 degrees");
  $("motion-connect").click();
  await until(() => !$("motion-arm").disabled);
  hotspots[1].click();
  $("motion-arm").checked = true;
  $("motion-arm").dispatchEvent(new Event("change"));
  $("servo-increase").click();
  await until(() => !$("motion-arm").disabled);
  assert.equal(mock.requests.at(-1).angle, 25);
  $("servo-step").value = "10";
  $("servo-increase").click();
  await until(() => !$("motion-arm").disabled);
  assert.equal(mock.requests.at(-1).angle, 30, "Large step clamps to the upper limit");
  $("motion-disconnect").click();
  await until(() => mock.closed);
});

test("44px servo targets do not overlap at narrow mobile or desktop map sizes", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  const positions = [...html.matchAll(/data-servo="(\w+)" style="--x:(\d+)%;--y:(\d+)%"/g)]
    .map(([, name, x, y]) => ({ name, x: Number(x), y: Number(y) }));
  const mobile = Object.fromEntries([...css.matchAll(/data-servo=(\w+)\] \{ --x: (\d+)% !important; --y: (\d+)% !important;/g)]
    .map(([, name, x, y]) => [name, { x: Number(x), y: Number(y) }]));
  assert.equal(positions.length, 9);
  for (const [width, overrides] of [[237, mobile], [500, {}]]) {
    const targets = positions.map(position => ({ ...position, ...overrides[position.name] }));
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i], b = targets[j];
        assert.ok(Math.abs(a.x - b.x) / 100 * width >= 44 ||
          Math.abs(a.y - b.y) / 100 * width * 799 / 800 >= 44,
        `${a.name} overlaps ${b.name} on a ${width}px map`);
      }
    }
  }
});
