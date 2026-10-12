export const MAX_FILE_BYTES = 96 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024;
const CHUNK_BYTES = 768;
const encoder = new TextEncoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function prepareFiles(selected) {
  if (!selected.length || selected.length > 16) throw new Error("Choose between 1 and 16 Python files.");
  const names = new Set();
  let total = 0;
  for (const file of selected) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}\.py$/.test(file.name)) {
      throw new Error(`${file.name}: use a root .py filename with letters, numbers and underscores only.`);
    }
    if (names.has(file.name)) throw new Error(`Duplicate filename: ${file.name}.`);
    names.add(file.name);
    if (!file.size || file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: files must be nonempty and at most 96 KiB.`);
    total += file.size;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("Selected files exceed the 256 KiB batch limit.");
  const files = [];
  for (const file of selected) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== file.size) throw new Error(`${file.name}: file size changed while reading.`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error(`${file.name}: Python source cannot contain null bytes.`);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    files.push({ name: file.name, bytes, hash: Array.from(hash, value => value.toString(16).padStart(2, "0")).join("") });
  }
  return files.sort((a, b) => (a.name === "main.py") - (b.name === "main.py") || a.name.localeCompare(b.name));
}

export class RawReplConnection {
  constructor(onFailure = () => {}) {
    this.onFailure = onFailure;
    this.buffer = "";
    this.opened = false;
    this.closing = false;
    this.failure = null;
  }

  async open(port) {
    this.port = port;
    await port.open({ baudRate: 115200, flowControl: "none" });
    this.opened = true;
    if (!port.readable || !port.writable) throw new Error("USB needs readable and writable streams.");
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.reading = this.read();
    await this.write("\r\x03\x03");
    await sleep(100);
    this.buffer = "";
    await this.write("\r\x01");
    await this.until("raw REPL; CTRL-B to exit\r\n>");
    this.raw = true;
    const identity = await this.exec("import sys\nprint(sys.implementation.name)\nprint(sys.platform)");
    if (identity.replaceAll("\r", "").trim() !== "micropython\nrp2") {
      throw new Error("Not RP2040 MicroPython. No files were written. Select the RP2040 programming port.");
    }
    await this.exec("from machine import Pin\nPin(8, Pin.OUT, value=1)");
  }

  async read() {
    const decoder = new TextDecoder();
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        if (this.buffer.length > 65536) throw new Error("USB REPL response exceeded 64 KiB.");
        this.drain();
      }
      if (!this.closing) throw new Error("RP2040 USB disconnected. Keep servo power off and inspect the upload folder before restarting.");
    } catch (error) {
      if (!this.closing) {
        this.fail(error);
        this.onFailure(error);
      }
    } finally {
      this.reader.releaseLock();
      this.reader = null;
    }
  }

  fail(error) {
    this.failure = error;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(error);
      this.waiter = null;
    }
  }

  drain() {
    if (!this.waiter) return;
    const end = this.buffer.indexOf(this.waiter.marker);
    if (end < 0) return;
    const output = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + this.waiter.marker.length);
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(output);
  }

  until(marker) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new Error("A REPL response is already pending."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("RP2040 REPL timed out. Keep servo power off; disconnect and check firmware, cable and backup files.")), 10000);
      this.waiter = { marker, resolve, reject, timer };
      this.drain();
    });
  }

  async write(text) {
    if (this.failure) throw this.failure;
    let timer;
    try {
      await Promise.race([
        this.writer.write(encoder.encode(text)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("USB write timed out. Keep servo power off and reconnect.")), 10000);
        }),
      ]);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async exec(source) {
    if (!this.raw || this.closing) throw new Error("Raw REPL is not connected.");
    // Standard raw REPL pacing matches MicroPython's pyboard.py fallback.
    for (let offset = 0; offset < source.length; offset += 256) {
      await this.write(source.slice(offset, offset + 256));
      await sleep(10);
    }
    await this.write("\x04");
    const acknowledgement = await this.until("OK");
    if (acknowledgement) throw new Error(`Unexpected REPL acknowledgement: ${acknowledgement}`);
    const output = await this.until("\x04");
    const error = await this.until("\x04");
    const prompt = await this.until(">");
    if (prompt) throw new Error("Unexpected data before the raw REPL prompt.");
    if (error.trim()) throw new Error(error.trim());
    return output.trim();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.fail(new Error("Firmware USB closed."));
    this.closePromise = (async () => {
      try {
        await this.reader?.cancel();
        await this.reading;
        if (this.writer) {
          await this.writer.abort();
          this.writer.releaseLock();
          this.writer = null;
        }
        if (this.opened) await this.port.close();
      } finally {
        this.opened = false;
      }
    })();
    return this.closePromise;
  }
}

export function createUploadPlan(files, token) {
  if (!/^[a-f0-9]{16}$/.test(token)) throw new Error("Invalid upload identifier.");
  const folder = `/_coglet_upload_${token}`;
  const quote = JSON.stringify;
  const names = files.map(file => file.name);
  const staged = name => `${folder}/${name}.new`;
  return {
    folder,
    begin: `import os, ubinascii, hashlib, json
_upload_names = ${quote(names)}
_upload_root = os.listdir("/")
for _upload_name in _upload_names:
 if _upload_name in _upload_root and not (os.stat("/" + _upload_name)[0] & 0x8000):
  raise ValueError("Destination is not a regular file: " + _upload_name)
_upload_space = os.statvfs("/")
if _upload_space[0] * _upload_space[3] < ${files.reduce((sum, file) => sum + file.bytes.length, 0) + 4096}:
 raise OSError("Not enough free flash for staging and backups")
os.mkdir(${quote(folder)})`,
    start: name => `with open(${quote(staged(name))}, "wb") as _upload_file:\n pass`,
    chunk: (name, bytes) => `with open(${quote(staged(name))}, "ab") as _upload_file:
 print(_upload_file.write(ubinascii.a2b_base64(${quote(btoa(String.fromCharCode(...bytes)))})))`,
    verify: name => `_upload_hash = hashlib.sha256()
with open(${quote(staged(name))}, "rb") as _upload_file:
 while True:
  _upload_block = _upload_file.read(512)
  if not _upload_block: break
  _upload_hash.update(_upload_block)
with open(${quote(staged(name))}, "r") as _upload_file:
 _upload_source = _upload_file.read()
try:
 compile(_upload_source, ${quote("/" + name)}, "exec")
finally:
 del _upload_source
print(ubinascii.hexlify(_upload_hash.digest()).decode())`,
    commit: `_upload_changed = []
_upload_backups = []
try:
 for _upload_name in _upload_names:
  _upload_target = "/" + _upload_name
  _upload_staged = ${quote(folder + "/")} + _upload_name + ".new"
  _upload_backup = ${quote(folder + "/")} + _upload_name + ".bak"
  _upload_existed = _upload_name in _upload_root
  _upload_change = [_upload_name, False, False]
  _upload_changed.append(_upload_change)
  if _upload_existed:
   os.rename(_upload_target, _upload_backup)
   _upload_change[1] = True
  os.rename(_upload_staged, _upload_target)
  _upload_change[2] = True
  if _upload_existed:
   _upload_backups.append(_upload_backup)
 os.sync()
except Exception as _upload_error:
 _upload_rollback_errors = []
 for _upload_name, _upload_backed_up, _upload_installed in reversed(_upload_changed):
  try:
   _upload_target = "/" + _upload_name
   if _upload_installed:
    os.rename(_upload_target, ${quote(folder + "/")} + _upload_name + ".new")
   if _upload_backed_up:
    os.rename(${quote(folder + "/")} + _upload_name + ".bak", _upload_target)
  except Exception as _upload_rollback_error:
   _upload_rollback_errors.append(_upload_name + ": " + str(_upload_rollback_error))
 try:
  os.sync()
 except Exception as _upload_sync_error:
  _upload_rollback_errors.append("Flash sync: " + str(_upload_sync_error))
 if _upload_rollback_errors:
  raise OSError("Replacement failed; rollback incomplete: " + "; ".join(_upload_rollback_errors))
 raise OSError("Replacement failed; previous files restored: " + str(_upload_error))
print(json.dumps({"installed": _upload_names, "backups": _upload_backups}))`,
  };
}

export async function uploadFiles(repl, files, onProgress = () => {}) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(8)), value => value.toString(16).padStart(2, "0")).join("");
  const plan = createUploadPlan(files, token);
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  let transferred = 0;
  let replacing = false;
  try {
    onProgress({ transferred, total, text: `Preparing ${plan.folder}` });
    await repl.exec(plan.begin);
    for (const file of files) {
      await repl.exec(plan.start(file.name));
      for (let offset = 0; offset < file.bytes.length; offset += CHUNK_BYTES) {
        const chunk = file.bytes.slice(offset, offset + CHUNK_BYTES);
        const written = await repl.exec(plan.chunk(file.name, chunk));
        if (written !== String(chunk.length)) throw new Error(`${file.name}: device did not acknowledge the complete chunk.`);
        transferred += chunk.length;
        onProgress({ transferred, total, text: `Staging ${file.name}` });
      }
      onProgress({ transferred, total, text: `Checking SHA-256 and syntax: ${file.name}` });
      if (await repl.exec(plan.verify(file.name)) !== file.hash) throw new Error(`${file.name}: SHA-256 verification failed.`);
    }
    onProgress({ transferred, total, text: "Replacing verified files; main.py last. Do not unplug USB." });
    replacing = true;
    const result = JSON.parse(await repl.exec(plan.commit));
    if (JSON.stringify(result.installed) !== JSON.stringify(files.map(file => file.name)) ||
        !Array.isArray(result.backups) || !result.backups.every(path => files.some(file => path === `${plan.folder}/${file.name}.bak`))) {
      throw new Error("Device returned an invalid installation receipt.");
    }
    return { ...result, folder: plan.folder };
  } catch (error) {
    throw new Error(`${error.message} ${replacing ? "Replacement was attempted; inspect root files and backups before restarting." : "No root files were replaced."} Upload folder (if created): ${plan.folder}. Keep servo power disconnected.`);
  }
}

export function setupResetGuide(root = document) {
  const trigger = root.getElementById("reset-guide-trigger");
  const popup = root.getElementById("reset-guide");
  if (!popup.showPopover) {
    const link = root.createElement("a");
    Object.assign(link, { href: "assets/rp2040-reset-pinout.png", textContent: trigger.textContent, className: trigger.className, target: "_blank", rel: "noopener" });
    trigger.replaceWith(link);
    return;
  }
  let timer;
  function hide() {
    clearTimeout(timer);
    if (popup.matches(":popover-open")) popup.hidePopover();
  }
  function show() {
    clearTimeout(timer);
    if (!popup.matches(":popover-open")) popup.showPopover();
    const rect = trigger.getBoundingClientRect();
    const { clientWidth, clientHeight } = root.documentElement;
    popup.style.left = `${Math.max(12, Math.min(rect.left, clientWidth - popup.offsetWidth - 12))}px`;
    const above = rect.top - popup.offsetHeight - 8;
    popup.style.top = `${Math.max(12, above >= 12 ? above : Math.min(rect.bottom + 8, clientHeight - popup.offsetHeight - 12))}px`;
  }
  function leave() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!trigger.matches(":hover") && !popup.matches(":hover") &&
          root.activeElement !== trigger && !popup.contains(root.activeElement)) hide();
    }, 200);
  }
  trigger.addEventListener("pointerenter", event => {
    if (event.pointerType !== "touch") show();
  });
  trigger.addEventListener("focus", event => {
    if (trigger.matches(":focus-visible") && !popup.contains(event.relatedTarget)) show();
  });
  for (const element of [trigger, popup]) {
    element.addEventListener("pointerleave", leave);
    element.addEventListener("focusout", leave);
  }
  popup.addEventListener("pointerenter", () => clearTimeout(timer));
  popup.addEventListener("toggle", event => {
    trigger.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState === "open") show();
  });
  root.defaultView.addEventListener("resize", hide);
  root.defaultView.addEventListener("scroll", hide, { passive: true });
  for (const panel of root.querySelectorAll('[role="tabpanel"]')) panel.addEventListener("tabshown", hide);
}

export function setupFirmware(otherConnectionActive) {
  setupResetGuide();
  const $ = id => document.getElementById(id);
  const supported = isSecureContext && "serial" in navigator;
  let connection = null;
  let ready = false;
  let busy = false;
  let files = [];

  function notice(text, error = false) {
    $("firmware-notice").textContent = text;
    $("firmware-notice").classList.toggle("error", error);
  }
  function controls() {
    const blocked = otherConnectionActive();
    $("firmware-connect").disabled = !supported || connection !== null || busy || blocked || !$("firmware-safe").checked;
    $("firmware-disconnect").disabled = connection === null || busy;
    $("firmware-files").disabled = busy;
    $("firmware-safe").disabled = connection !== null || busy;
    $("firmware-confirm").disabled = busy || !files.length;
    $("firmware-upload").disabled = !ready || busy || !files.length || !$("firmware-confirm").checked;
    $("firmware-blocked").hidden = !blocked;
    $("firmware-connection").textContent = ready ? "Connected - firmware stopped" : connection ? "Connecting..." : "Disconnected";
  }
  async function disconnect() {
    ready = false;
    const old = connection;
    try {
      await old?.close();
    } catch (error) {
      notice(`Could not close firmware USB: ${error.message}. Unplug USB before reconnecting. Keep servo power off.`, true);
    } finally {
      connection = null;
      $("firmware-safe").checked = false;
      $("firmware-confirm").checked = false;
      controls();
    }
  }
  $("firmware-safe").addEventListener("change", controls);
  $("firmware-confirm").addEventListener("change", controls);
  $("firmware-files").addEventListener("change", async event => {
    if (busy) return;
    busy = true;
    files = [];
    $("firmware-confirm").checked = false;
    $("firmware-result").textContent = "";
    $("firmware-progress").hidden = true;
    $("firmware-file-list").replaceChildren();
    controls();
    try {
      files = await prepareFiles(Array.from(event.target.files));
      for (const file of files) {
        const row = document.createElement("li");
        const name = document.createElement("code");
        name.textContent = `/${file.name}`;
        row.append(name, ` - ${file.bytes.length.toLocaleString()} bytes${file.name === "main.py" ? " - installed last" : ""}`);
        $("firmware-file-list").append(row);
      }
      notice("Files reviewed. Connect the RP2040, then confirm replacement to upload.");
    } catch (error) {
      event.target.value = "";
      notice(`File selection rejected: ${error.message}`, true);
    } finally {
      busy = false;
      if (connection?.failure) {
        notice(connection.failure.message, true);
        await disconnect();
      }
      controls();
    }
  });
  $("firmware-connect").addEventListener("click", async () => {
    if (connection || busy || otherConnectionActive() || !$("firmware-safe").checked) return;
    busy = true;
    connection = new RawReplConnection(error => {
      ready = false;
      notice(error.message, true);
      if (!busy) void disconnect();
    });
    controls();
    try {
      const port = await navigator.serial.requestPort();
      notice("Interrupting the program and checking RP2040 MicroPython. No files are being replaced.");
      await connection.open(port);
      ready = true;
      notice("RP2040 MicroPython detected. Firmware is interrupted and GPIO8 disables PWM. Keep external servo power disconnected.");
    } catch (error) {
      notice(error.name === "NotFoundError" ? "No firmware port selected." : `Firmware connection failed: ${error.message} The program may already be interrupted. Keep servo power off.`, error.name !== "NotFoundError");
      await disconnect();
    } finally {
      busy = false;
      controls();
    }
  });
  $("firmware-disconnect").addEventListener("click", async () => {
    if (!connection || busy) return;
    busy = true;
    notice("Closing firmware USB without restarting. Keep power off until you are ready for startup movement.");
    await disconnect();
    busy = false;
    controls();
  });
  $("firmware-upload").addEventListener("click", async () => {
    if (!ready || busy || !files.length || !$("firmware-confirm").checked) return;
    busy = true;
    $("firmware-result").textContent = "";
    $("firmware-progress").hidden = false;
    $("firmware-progress").value = 0;
    controls();
    try {
      const result = await uploadFiles(connection, files, progress => {
        $("firmware-progress").max = progress.total;
        $("firmware-progress").value = progress.transferred;
        notice(`${progress.text} (${progress.transferred.toLocaleString()} / ${progress.total.toLocaleString()} bytes)`);
      });
      $("firmware-result").textContent = `Installed: ${result.installed.join(", ")}.\nBackups on RP2040: ${result.backups.length ? result.backups.join(", ") : "None needed; all destinations were new."}\nUpload folder: ${result.folder}`;
      notice("Upload verified and installed. Nothing was started. Disconnect firmware USB, close other serial monitors, then manually press RP2040 RESET when the mechanism is clear. Reset may restore PWM and startup movement.");
    } catch (error) {
      notice(`Upload failed: ${error.message}`, true);
      await disconnect();
    } finally {
      $("firmware-confirm").checked = false;
      busy = false;
      controls();
    }
  });
  controls();
  if (!supported) notice("Firmware uploads need desktop Chrome or Edge on localhost or HTTPS.", true);
  return { get connected() { return connection !== null; }, updateControls: controls };
}
