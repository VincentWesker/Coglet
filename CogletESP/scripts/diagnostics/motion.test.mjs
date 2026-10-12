import { test } from "node:test";
import assert from "node:assert/strict";
import { MotionConnection, validateCapabilities } from "./motion.js";

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
