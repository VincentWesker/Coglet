import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTabs } from "./tabs.js";

function fixture() {
  let focused = null;
  class Tab extends EventTarget {
    constructor(panel) {
      super();
      this.attributes = { "aria-controls": panel };
    }
    getAttribute(name) { return this.attributes[name]; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { focused = this; }
  }
  const tabs = [new Tab("logging-panel"), new Tab("motion-panel"), new Tab("firmware-panel")];
  const panels = {
    "logging-panel": Object.assign(new EventTarget(), { hidden: false, savedLog: "captured messages" }),
    "motion-panel": Object.assign(new EventTarget(), { hidden: true, target: 40, connected: true }),
    "firmware-panel": Object.assign(new EventTarget(), { hidden: true, files: ["main.py"], uploading: true }),
  };
  setupTabs({
    querySelectorAll: () => tabs,
    getElementById: id => panels[id],
  });
  return { tabs, panels, get focused() { return focused; } };
}

function key(tab, name) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: name });
  tab.dispatchEvent(event);
  return event.defaultPrevented;
}

test("Logging is selected by default with one keyboard tab stop", () => {
  const { tabs, panels } = fixture();
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].getAttribute("aria-selected"), "false");
  assert.deepEqual(tabs.map(tab => tab.tabIndex), [0, -1, -1]);
  assert.equal(panels["logging-panel"].hidden, false);
  assert.equal(panels["motion-panel"].hidden, true);
});

test("clicking tabs changes visibility without replacing stored state", () => {
  const { tabs, panels } = fixture();
  const motion = panels["motion-panel"];
  tabs[1].dispatchEvent(new Event("click"));
  assert.equal(panels["logging-panel"].hidden, true);
  assert.equal(motion.hidden, false);
  tabs[0].dispatchEvent(new Event("click"));
  assert.equal(panels["motion-panel"], motion);
  assert.equal(motion.target, 40);
  assert.equal(motion.connected, true);
  assert.equal(panels["logging-panel"].savedLog, "captured messages");
});

test("arrows wrap and Home/End activate and focus the corresponding tab", () => {
  const view = fixture();
  assert.equal(key(view.tabs[0], "ArrowLeft"), true);
  assert.equal(view.focused, view.tabs[2]);
  assert.equal(key(view.tabs[2], "ArrowRight"), true);
  assert.equal(view.focused, view.tabs[0]);
  key(view.tabs[0], "End");
  assert.equal(view.focused, view.tabs[2]);
  key(view.tabs[2], "Home");
  assert.equal(view.focused, view.tabs[0]);
  assert.equal(key(view.tabs[0], "Tab"), false);
  assert.deepEqual(view.tabs.map(tab => tab.tabIndex), [0, -1, -1]);
});

test("Firmware retains selected files and a running upload across tab switches", () => {
  const { tabs, panels } = fixture();
  tabs[2].dispatchEvent(new Event("click"));
  assert.equal(panels["firmware-panel"].hidden, false);
  tabs[0].dispatchEvent(new Event("click"));
  assert.equal(panels["firmware-panel"].hidden, true);
  assert.deepEqual(panels["firmware-panel"].files, ["main.py"]);
  assert.equal(panels["firmware-panel"].uploading, true);
});

test("the selected panel is notified after becoming visible", () => {
  const { tabs, panels } = fixture();
  let notified = false;
  panels["motion-panel"].addEventListener("tabshown", () => {
    notified = true;
    assert.equal(panels["motion-panel"].hidden, false);
  });
  tabs[1].dispatchEvent(new Event("click"));
  assert.equal(notified, true);
});
