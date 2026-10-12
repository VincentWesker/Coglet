import { test } from "node:test";
import assert from "node:assert/strict";
import { LogBuffer, analyze, parseLine } from "./diagnostics.js";

test("ESP-IDF ANSI logs parse without treating unstructured lines as info", () => {
  assert.deepEqual(parseLine("\x1b[0;31mE (42) Esp32Camera: Read failed\x1b[0m\r"), {
    text: "E (42) Esp32Camera: Read failed", level: "E", tag: "Esp32Camera", message: "Read failed",
  });
  assert.equal(parseLine("RP2040 ready").level, "");
});
test("chunked CRLF and final partial line are retained", () => {
  const buffer = new LogBuffer();
  buffer.append("I (1) Application: STA");
  buffer.append("TE: idle\r");
  buffer.append("\nlast line");
  buffer.flush();
  assert.equal(buffer.lines.length, 2);
  assert.equal(buffer.lines[0].message, "STATE: idle");
  assert.equal(buffer.lines[1].text, "last line");
});
test("capture bounds lines and partial input and reports loss", () => {
  const buffer = new LogBuffer(2, 8);
  buffer.append("a\nb\nc\n123456789");
  buffer.append("more");
  assert.equal(buffer.pending.length, 8);
  buffer.flush();
  assert.equal(buffer.evicted, 2);
  assert.equal(buffer.truncated, 1);
  assert.deepEqual(buffer.lines.map(line => line.text), ["c", "12345678 [line truncated]"]);
  buffer.clear();
  assert.equal(buffer.total, 0);
  assert.equal(buffer.evicted, 0);
});
test("missing evidence is unknown, never healthy", () => {
  assert.ok(analyze([]).every(item => item.status === "Not observed"));
});
test("real firmware messages yield evidence without false camera failure", () => {
  const lines = [
    "I (10) SystemInfo: free sram: 90000 minimal sram: 75000",
    "I (20) SystemInfo: free sram: 80000 minimal sram: 70000",
    "I (30) Application: STATE: listening",
    "W (40) CompactWifiBoard: Camera initialized successfully; camera MCP tool is available",
    "E (50) NoAudioCodec: Read failed: ESP_FAIL",
    "I (60) WifiStation: Connected",
    "Guru Meditation Error: Core 0 panic'ed",
  ].map(parseLine);
  const report = analyze(lines);
  assert.equal(report.find(item => item.title === "Crash / reset").status, "Investigate");
  assert.match(report.find(item => item.title === "Memory").summary, /80000.*70000/);
  assert.match(report.find(item => item.title === "Application state").summary, /listening/);
  assert.equal(report.find(item => item.title === "Audio").status, "Investigate");
  assert.equal(report.find(item => item.title === "Network").status, "Observed");
  assert.match(report.find(item => item.title === "Network").summary, /^1 relevant message\./);
  // Board-tagged camera messages must still count as camera evidence.
  assert.equal(report.find(item => item.title === "Camera").status, "Observed");
});
