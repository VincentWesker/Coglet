import { LogBuffer, analyze } from "./diagnostics.js";

const $ = id => document.getElementById(id);
const buffer = new LogBuffer();
let port = null;
let reader = null;
let closing = false;
let busy = false;
let paused = false;
let dirty = false;
let analyzedTotal = null;
const supportsSerial = isSecureContext && "serial" in navigator;

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function controls() {
  const hasData = buffer.lines.length > 0;
  $("connect").disabled = !supportsSerial || port !== null || busy;
  $("disconnect").disabled = port === null || reader === null || closing;
  $("import").disabled = port !== null || busy;
  $("pause").disabled = !hasData;
  $("analyze").disabled = !hasData;
  $("export").disabled = !hasData;
  $("clear").disabled = !hasData && !buffer.pending;
}

function updateCapture() {
  controls();
  $("count").textContent = `${buffer.lines.length.toLocaleString()} lines${paused ? " · view paused" : ""}`;
  $("capture").textContent = `${buffer.evicted.toLocaleString()} older lines dropped · ${buffer.truncated.toLocaleString()} long lines truncated`;
  if (analyzedTotal !== null && analyzedTotal !== buffer.total) {
    $("analysis-status").textContent = "New log data captured. Run diagnostics to update the report.";
  }
}

function renderLog() {
  const log = $("log");
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const search = $("search").value.toLowerCase();
  const level = $("level").value;
  const visible = buffer.lines.filter(line => (level === "all" || line.level === level) && line.text.toLowerCase().includes(search));
  const fragment = document.createDocumentFragment();
  for (const line of visible) {
    const span = document.createElement("span");
    span.textContent = `${line.text}\n`;
    if (line.level === "E") span.className = "line-error";
    if (line.level === "W") span.className = "line-warning";
    fragment.append(span);
  }
  if (!visible.length) {
    const span = document.createElement("span");
    span.className = "empty";
    span.textContent = buffer.lines.length ? "No messages match these filters." : "No messages yet. Connect Coglet or import a saved log.";
    fragment.append(span);
  }
  log.replaceChildren(fragment);
  if (follow) log.scrollTop = log.scrollHeight;
}

function received(text) {
  buffer.append(text);
  dirty = true;
}

async function connect() {
  if (port !== null || busy) return;
  busy = true;
  controls();
  let selected;
  try {
    selected = await navigator.serial.requestPort();
  } catch (error) {
    notice(error.name === "NotFoundError" ? "No port selected. Choose the Coglet ESP32 console when ready." : `Port selection failed: ${error.message}`, error.name !== "NotFoundError");
    busy = false;
    controls();
    return;
  }
  port = selected;
  busy = false;
  controls();
  notice("Opening the serial console…");
  try {
    await port.open({ baudRate: 115200, flowControl: "none" });
    $("connection").textContent = "Connected · USB";
    $("connection").classList.add("live");
    notice("Capturing serial logs. This UI sends no commands. Opening some USB adapters may reset the board.");
    const decoder = new TextDecoder();
    if (!port.readable) throw new Error("The selected port has no readable stream.");
    reader = port.readable.getReader();
    controls();
    while (!closing) {
      const { value, done } = await reader.read();
      if (done) break;
      received(decoder.decode(value, { stream: true }));
    }
    received(decoder.decode());
    if (!closing) notice("The serial stream ended. Check the USB cable, then reconnect.", true);
  } catch (error) {
    notice(`Serial connection failed: ${error.message}. Close other serial monitors and check the USB cable.`, true);
  } finally {
    reader?.releaseLock();
    reader = null;
    buffer.flush();
    dirty = true;
    try {
      if (port.readable || port.writable) await port.close();
    } catch (error) {
      notice(`Could not close the serial port: ${error.message}. Unplug and reconnect the device before retrying.`, true);
    }
    port = null;
    closing = false;
    $("connection").textContent = "Disconnected";
    $("connection").classList.remove("live");
    controls();
  }
}

$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", async () => {
  if (!reader || closing) return;
  closing = true;
  controls();
  notice("Disconnected. Captured logs remain available for review.");
  try {
    await reader.cancel();
  } catch (error) {
    notice(`Disconnect failed: ${error.message}. Check the USB connection.`, true);
  }
});

$("analyze").addEventListener("click", () => {
  const fragment = document.createDocumentFragment();
  for (const item of analyze(buffer.lines)) {
    const section = document.createElement("section");
    section.className = "finding";
    const heading = document.createElement("h3");
    heading.textContent = item.title;
    const state = document.createElement("span");
    state.className = `state${item.status === "Investigate" ? " issue" : item.status === "Review" ? " warning" : ""}`;
    state.textContent = item.status;
    heading.append(state);
    const summary = document.createElement("p");
    summary.textContent = item.summary;
    section.append(heading, summary);
    if (item.evidence.length) {
      const details = document.createElement("details");
      const label = document.createElement("summary");
      label.textContent = "Source messages";
      const evidence = document.createElement("pre");
      evidence.className = "evidence";
      evidence.textContent = item.evidence.join("\n");
      details.append(label, evidence);
      section.append(details);
    }
    fragment.append(section);
  }
  $("results").replaceChildren(fragment);
  $("results").classList.remove("report-ready");
  void $("results").offsetWidth;
  $("results").classList.add("report-ready");
  analyzedTotal = buffer.total;
  $("analysis-status").textContent = `Reviewed ${buffer.lines.length.toLocaleString()} retained lines at ${new Date().toLocaleTimeString()}.`;
});

$("pause").addEventListener("click", () => {
  paused = !paused;
  $("pause").textContent = paused ? "Resume view" : "Pause view";
  updateCapture();
  if (!paused) renderLog();
});
for (const id of ["search", "level"]) {
  $(id).addEventListener("input", () => {
    if (!paused) renderLog();
    else notice("The view is paused. Resume to apply filters; capture continues.");
  });
}
$("clear").addEventListener("click", () => {
  buffer.clear();
  analyzedTotal = null;
  $("results").replaceChildren();
  $("analysis-status").textContent = "Waiting for log data.";
  paused = false;
  $("pause").textContent = "Pause view";
  updateCapture();
  renderLog();
});
$("export").addEventListener("click", () => {
  const blob = new Blob([buffer.lines.map(line => line.text).join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `coglet-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("import").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file || port !== null || busy) return;
  if (file.size > 2 * 1024 * 1024) {
    notice("Log is larger than 2 MiB. Import a smaller excerpt instead.", true);
    event.target.value = "";
    return;
  }
  busy = true;
  controls();
  try {
    const text = await file.text();
    buffer.clear();
    buffer.append(text);
    buffer.flush();
    analyzedTotal = null;
    $("results").replaceChildren();
    $("analysis-status").textContent = "Saved log loaded. Run diagnostics to review it.";
    paused = false;
    $("pause").textContent = "Pause view";
    notice(`Imported ${file.name}. This is saved log data, not a live connection.`);
    updateCapture();
    renderLog();
  } catch (error) {
    notice(`Log import failed: ${error.message}. Choose a readable text file.`, true);
  } finally {
    event.target.value = "";
    busy = false;
    controls();
  }
});
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  updateCapture();
  if (!paused) renderLog();
}, 150);
controls();
if (!supportsSerial) notice("USB connection needs desktop Chrome or Edge on localhost or HTTPS. Saved-log import and diagnostics still work here.", true);
