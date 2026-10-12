const PREFIX = "COGLET_DIAG ";
const labels = {
  YAW: "Base yaw", ROL: "Neck roll", PIT: "Neck pitch", MOU: "Mouth",
  EYL: "Left eye", EYR: "Right eye", LID: "Eyelid", EAL: "Left ear", EAR: "Right ear",
};

export function validateCapabilities(data) {
  if (data.service !== "coglet-motion" || data.version !== 1 || data.leaseMs !== 5000 ||
      !Array.isArray(data.servos) || !data.servos.length ||
      typeof data.calibrating !== "boolean" ||
      !Array.isArray(data.animations) || !Array.isArray(data.actions)) {
    throw new Error("This port is not running compatible Coglet motion firmware.");
  }
  const names = new Set();
  for (const servo of data.servos) {
    if (!Object.hasOwn(labels, servo.name) || names.has(servo.name) ||
        !Number.isInteger(servo.socket) || servo.socket < 0 || servo.socket > 11 ||
        ![servo.min, servo.max, servo.target].every(Number.isFinite) ||
        servo.min < 0 || servo.max > 180 || servo.min >= servo.max) {
      throw new Error("The motion firmware reported invalid servo limits.");
    }
    names.add(servo.name);
  }
  if (![...data.animations, ...data.actions].every(name => typeof name === "string" && /^[a-z_]{1,40}$/.test(name))) {
    throw new Error("The motion firmware reported invalid animation names.");
  }
  return data;
}

export class MotionConnection {
  constructor(onStatus, onFailure) {
    this.onStatus = onStatus;
    this.onFailure = onFailure;
    this.port = null;
    this.reader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.writes = Promise.resolve();
    this.closing = false;
    this.opened = false;
  }

  async open(port) {
    this.port = port;
    try {
      await port.open({ baudRate: 115200, flowControl: "none" });
      this.opened = true;
      if (!port.readable || !port.writable) throw new Error("This port needs readable and writable streams.");
      this.reader = port.readable.getReader();
      this.reading = this.read();
      return validateCapabilities(await this.send("hello"));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async read() {
    let partial = "";
    const decoder = new TextDecoder();
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        partial += decoder.decode(value, { stream: true });
        let end;
        while ((end = partial.indexOf("\n")) >= 0) {
          const line = partial.slice(0, end).trim();
          partial = partial.slice(end + 1);
          if (!line.startsWith(PREFIX)) continue;
          let response;
          try {
            response = JSON.parse(line.slice(PREFIX.length));
          } catch {
            throw new Error("Invalid response from motion firmware.");
          }
          if (!response || typeof response !== "object") throw new Error("Invalid motion response.");
          const pending = this.pending.get(response.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(response.id);
            if (response.ok === true) pending.resolve(response);
            else pending.reject(new Error(response.error || "Motion command rejected."));
          }
          this.onStatus(response);
        }
        if (partial.length > 16384) throw new Error("Motion serial response exceeded the capture limit.");
      }
      if (!this.closing) throw new Error("Motion USB disconnected. PWM will disable after the 5-second heartbeat timeout.");
    } catch (error) {
      this.rejectPending(error);
      if (!this.closing) this.onFailure(error);
    } finally {
      this.reader.releaseLock();
      this.reader = null;
    }
  }

  send(command, fields = {}) {
    if (this.closing || !this.reader || !this.port?.writable) return Promise.reject(new Error("Motion USB is not connected."));
    const id = this.nextId++;
    const bytes = new TextEncoder().encode(`diag:${JSON.stringify({ ...fields, id, command })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("No acknowledgement from RP2040. Check its firmware and USB connection."));
      }, 2000);
      this.pending.set(id, { resolve, reject, timer });
      this.writes = this.writes.then(async () => {
        if (!this.pending.has(id)) return;
        const writer = this.port.writable.getWriter();
        try {
          await writer.write(bytes);
        } finally {
          writer.releaseLock();
        }
      }).catch(error => {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(error);
        }
      });
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.rejectPending(new Error("Motion connection closed."));
    this.closePromise = (async () => {
      try {
        await this.reader?.cancel();
        await this.reading;
        await this.writes;
        if (this.opened && (this.port?.readable || this.port?.writable)) await this.port.close();
      } finally {
        this.port = null;
        this.opened = false;
      }
    })();
    return this.closePromise;
  }
}

export function setupMotion(firmwareConnected = () => false) {
  const $ = id => document.getElementById(id);
  const supported = isSecureContext && "serial" in navigator;
  let connection = null;
  let ready = false;
  let busy = false;
  let calibrating = false;
  let heartbeat = null;
  let heartbeatPending = false;
  let capabilities = null;
  let ownsMotion = false;
  const hotspots = [...$("servo-hotspots").querySelectorAll("[data-servo]")];

  function notice(text, error = false) {
    $("motion-notice").textContent = text;
    $("motion-notice").classList.toggle("error", error);
    if (!$("motion-stop-status").hidden) {
      $("motion-stop-status").textContent = text;
      $("motion-stop-status").classList.toggle("error", error);
    }
  }
  function controls() {
    const armed = ready && !calibrating && $("motion-arm").checked;
    $("motion-connect").disabled = !supported || connection !== null || firmwareConnected();
    $("motion-disconnect").disabled = !ready || busy;
    $("motion-arm").disabled = !ready || calibrating || busy;
    $("servo-controls").disabled = !armed || busy;
    $("animation-controls").disabled = !armed || busy;
    $("motion-resume").disabled = !armed || busy;
    $("motion-stop").disabled = !ready || calibrating;
    $("motion-connection").textContent = ready ? (calibrating ? "Calibration owns motion" : "Connected · RP2040") : connection ? "Connecting…" : "Disconnected";
    $("motion-connection").classList.toggle("live", ready);
    for (const button of hotspots) {
      button.disabled = !ready || busy || !capabilities?.servos.some(servo => servo.name === button.dataset.servo);
      button.setAttribute("aria-pressed", String(ready && button.dataset.servo === $("servo-name").value));
    }
    const angle = Number($("servo-angle").value);
    const validAngle = ready && $("servo-angle").checkValidity();
    $("servo-decrease").disabled = !armed || busy || !validAngle || angle <= Number($("servo-angle").min);
    $("servo-increase").disabled = !armed || busy || !validAngle || angle >= Number($("servo-angle").max);
  }
  async function shutdown() {
    clearInterval(heartbeat);
    heartbeat = null;
    ready = false;
    ownsMotion = false;
    $("motion-arm").checked = false;
    const old = connection;
    controls();
    try {
      await old?.close();
    } catch (error) {
      notice(`Could not close motion USB: ${error.message}. Unplug the RP2040 before reconnecting.`, true);
    } finally {
      connection = null;
      controls();
    }
  }
  function fail(error) {
    notice(`${error.message} Motion controls are disabled; no further commands will be sent.`, true);
    void shutdown();
  }
  function status(response) {
    if (typeof response.calibrating === "boolean") {
      const wasCalibrating = calibrating;
      calibrating = response.calibrating;
      if (calibrating) {
        ownsMotion = false;
        $("motion-arm").checked = false;
        notice("Physical Calibration Mode has priority. Turn it off before enabling USB motion.", true);
      } else if (wasCalibrating) {
        notice("Physical Calibration Mode ended. Clear the mechanism and enable motion controls again.");
      }
    }
    if (response.event === "timeout") {
      ownsMotion = false;
      $("motion-arm").checked = false;
      notice("Heartbeat expired. PWM outputs are disabled. Re-enable motion to move or resume normal behavior.", true);
    }
    controls();
  }
  async function command(name, fields = {}) {
    if (!ready || calibrating || (name !== "stop" && !$("motion-arm").checked)) return;
    if (busy && name !== "stop") return;
    $("motion-stop-status").hidden = name !== "stop";
    if (name === "stop") {
      notice("Requesting stop. Waiting for RP2040 acknowledgement.");
      $("motion-arm").checked = false;
      ownsMotion = false;
    }
    busy = true;
    controls();
    try {
      await connection.send(name, fields);
      if (name === "servo") {
        capabilities.servos.find(servo => servo.name === fields.name).target = fields.angle;
        $("servo-target").textContent = `${fields.angle}°`;
      }
      ownsMotion = ["servo", "animation", "action"].includes(name);
      notice(name === "stop" ? "RP2040 acknowledged stop. PWM disabled; servo power remains on." :
        name === "resume" ? "RP2040 acknowledged resume. Normal ESP32 animations and face tracking may move the robot." :
        `RP2040 acknowledged ${name}: ${fields.name}${name === "servo" ? ` at ${fields.angle}°` : ""}. This is not position feedback.`);
      if (name === "stop" || name === "resume") $("motion-arm").checked = false;
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
      controls();
    }
  }
  function selectServo() {
    const servo = capabilities.servos.find(item => item.name === $("servo-name").value);
    $("servo-angle").min = servo.min;
    $("servo-angle").max = servo.max;
    $("servo-angle").value = Math.min(servo.max, Math.max(servo.min, servo.target));
    $("servo-selected").textContent = labels[servo.name];
    $("servo-target").textContent = `${$("servo-angle").value}°`;
    $("servo-limits").textContent = `Socket ${servo.socket} · ${servo.min}–${servo.max}° firmware limits. Value is a requested target, not a measured position.`;
    controls();
  }
  function populate() {
    $("servo-name").replaceChildren(...capabilities.servos.map(servo => new Option(labels[servo.name], servo.name)));
    $("animation-name").replaceChildren(
      ...capabilities.animations.map(name => new Option(name.replaceAll("_", " "), `animation:${name}`)),
      ...capabilities.actions.map(name => new Option(`${name.replaceAll("_", " ")} · 2-second action`, `action:${name}`)),
    );
    selectServo();
  }
  $("motion-connect").addEventListener("click", async () => {
    if (connection || firmwareConnected()) return;
    let selected;
    // Reserve this connection before the port chooser opens.
    connection = new MotionConnection(status, error => {
      if (ready) fail(error);
    });
    const current = connection;
    controls();
    try {
      selected = await navigator.serial.requestPort();
      notice("Checking RP2040 motion firmware. No movement is requested.");
      capabilities = await current.open(selected);
      calibrating = capabilities.calibrating;
      ready = true;
      populate();
      notice(calibrating ? "Connected, but physical Calibration Mode owns motion. Turn it off first." :
        "Motion firmware detected. Keep the mechanism clear, then enable motion controls.");
      heartbeat = setInterval(async () => {
        if (!ready || heartbeatPending) return;
        heartbeatPending = true;
        try {
          await current.send("keepalive", { renew: ownsMotion });
        } catch (error) {
          fail(error);
        } finally {
          heartbeatPending = false;
        }
      }, 1000);
    } catch (error) {
      notice(error.name === "NotFoundError" ? "No motion port selected." :
        `${error.message} Install the updated RP2040 files and select its USB port, not the ESP32 console.`, error.name !== "NotFoundError");
      await shutdown();
    }
    controls();
  });
  $("motion-disconnect").addEventListener("click", async () => {
    busy = true;
    controls();
    try {
      if (!calibrating) await connection.send("stop");
      notice(calibrating ? "Disconnected motion USB. Physical Calibration Mode remains in control." : "Stopped PWM and disconnected motion USB.");
    } catch (error) {
      notice(`Stop could not be acknowledged: ${error.message}. A previously active USB override will disable PWM after 5 seconds.`, true);
    } finally {
      await shutdown();
      busy = false;
      controls();
    }
  });
  $("motion-arm").addEventListener("change", () => {
    controls();
    if (!$("motion-arm").checked) void command("stop");
  });
  $("servo-name").addEventListener("change", selectServo);
  for (const button of hotspots) {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      $("servo-name").value = button.dataset.servo;
      selectServo();
    });
  }
  $("coglet-image").addEventListener("error", () => { $("servo-image-error").hidden = false; });
  $("servo-angle").addEventListener("input", controls);
  const showStep = () => {
    const step = $("servo-step").value;
    for (const [id, sign, verb] of [["servo-decrease", "-", "Decrease"], ["servo-increase", "+", "Increase"]]) {
      $(id).setAttribute("aria-label", `${verb} servo target by ${step} degree${step === "1" ? "" : "s"}`);
      $(id).querySelector("span").textContent = `${sign}${step}°`;
    }
  };
  $("servo-step").addEventListener("change", showStep);
  showStep();
  for (const [id, sign] of [["servo-decrease", -1], ["servo-increase", 1]]) {
    $(id).addEventListener("click", () => {
      if ($(id).disabled || !$("servo-angle").reportValidity()) return;
      const angle = Math.min(Number($("servo-angle").max),
        Math.max(Number($("servo-angle").min), Number($("servo-angle").value) + sign * Number($("servo-step").value)));
      $("servo-angle").value = angle;
      void command("servo", { name: $("servo-name").value, angle });
    });
  }
  document.addEventListener("keydown", event => {
    const id = { ArrowLeft: "servo-decrease", ArrowRight: "servo-increase" }[event.key];
    if (!id || event.repeat || $("motion-panel").hidden || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        event.target?.closest?.("input, select, textarea, [role=tab]")) return;
    event.preventDefault();
    $(id).click();
  });
  $("servo-form").addEventListener("submit", event => {
    event.preventDefault();
    if ($("servo-angle").reportValidity()) {
      void command("servo", { name: $("servo-name").value, angle: Number($("servo-angle").value) });
    }
  });
  $("animation-form").addEventListener("submit", event => {
    event.preventDefault();
    const [kind, name] = $("animation-name").value.split(":");
    void command(kind, { name });
  });
  $("motion-stop").addEventListener("click", () => void command("stop"));
  $("motion-resume").addEventListener("click", () => void command("resume"));
  controls();
  if (!supported) notice("Motion USB needs desktop Chrome or Edge on localhost or HTTPS.", true);
  return { get connected() { return connection !== null; }, updateControls: controls };
}
