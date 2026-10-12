import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResetGuide } from "./firmware.js";

function event(type, properties = {}) {
  const value = new Event(type);
  for (const [key, property] of Object.entries(properties)) Object.defineProperty(value, key, { value: property });
  return value;
}

function fixture() {
  class Element extends EventTarget {
    attributes = {};
    hovered = false;
    focused = false;
    open = false;
    style = {};
    matches(selector) {
      return selector === ":popover-open" ? this.open : selector === ":hover" ? this.hovered : this.focused;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    contains(value) { return value === this || value === this.child; }
    showPopover() {
      this.open = true;
      this.dispatchEvent(event("toggle", { newState: "open" }));
    }
    hidePopover() {
      this.open = false;
      this.dispatchEvent(event("toggle", { newState: "closed" }));
    }
  }
  const trigger = new Element();
  const popup = new Element();
  const panel = new EventTarget();
  const view = new EventTarget();
  const rect = { left: 1150, top: 850, bottom: 870 };
  trigger.getBoundingClientRect = () => rect;
  popup.offsetWidth = 520;
  popup.offsetHeight = 500;
  popup.child = {};
  const root = {
    documentElement: { clientWidth: 1440, clientHeight: 900 },
    activeElement: null,
    defaultView: view,
    getElementById: id => id === "reset-guide-trigger" ? trigger : popup,
    querySelectorAll: () => [panel],
  };
  return { trigger, popup, panel, view, rect, root };
}

test("hover opens the guide without hardware commands and positions it inside the viewport", () => {
  const { trigger, popup, root, rect } = fixture();
  setupResetGuide(root);
  trigger.dispatchEvent(event("pointerenter", { pointerType: "mouse" }));
  assert.equal(popup.open, true);
  assert.equal(trigger.attributes["aria-expanded"], "true");
  assert.equal(popup.style.left, "908px");
  assert.equal(popup.style.top, "342px");
  popup.hidePopover();
  root.documentElement = { clientWidth: 390, clientHeight: 700 };
  popup.offsetWidth = 366;
  rect.left = 10;
  rect.top = 20;
  rect.bottom = 40;
  trigger.dispatchEvent(event("pointerenter", { pointerType: "mouse" }));
  assert.equal(popup.style.left, "12px");
  assert.equal(popup.style.top, "48px");
});

test("touch does not open on pointer entry, avoiding a toggle closed on the subsequent tap", () => {
  const { trigger, popup, root } = fixture();
  setupResetGuide(root);
  trigger.dispatchEvent(event("pointerenter", { pointerType: "touch" }));
  assert.equal(popup.open, false);
});

test("the guide remains open while moving onto it and closes after leaving both surfaces", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { trigger, popup, root } = fixture();
  setupResetGuide(root);
  trigger.dispatchEvent(event("pointerenter", { pointerType: "mouse" }));
  trigger.dispatchEvent(event("pointerleave"));
  popup.dispatchEvent(event("pointerenter"));
  context.mock.timers.tick(250);
  assert.equal(popup.open, true);
  popup.dispatchEvent(event("pointerleave"));
  context.mock.timers.tick(250);
  assert.equal(popup.open, false);
  assert.equal(trigger.attributes["aria-expanded"], "false");
});

test("keyboard focus opens the guide and a close restoring focus does not reopen it", () => {
  const { trigger, popup, root } = fixture();
  setupResetGuide(root);
  trigger.focused = true;
  root.activeElement = trigger;
  trigger.dispatchEvent(event("focus", { relatedTarget: null }));
  assert.equal(popup.open, true);
  popup.hidePopover();
  trigger.dispatchEvent(event("focus", { relatedTarget: popup.child }));
  assert.equal(popup.open, false);
});

test("tab changes, scrolling and resizing dismiss the guide", () => {
  const { trigger, popup, panel, view, root } = fixture();
  setupResetGuide(root);
  for (const [element, type] of [[panel, "tabshown"], [view, "scroll"], [view, "resize"]]) {
    trigger.dispatchEvent(event("pointerenter", { pointerType: "mouse" }));
    assert.equal(popup.open, true);
    element.dispatchEvent(event(type));
    assert.equal(popup.open, false);
  }
});

test("browsers without Popover API get a link to the annotated image", () => {
  const { trigger, popup, root } = fixture();
  popup.showPopover = undefined;
  trigger.textContent = "RP2040 RESET";
  trigger.className = "reset-guide-trigger";
  let replacement;
  trigger.replaceWith = link => { replacement = link; };
  root.createElement = () => ({});
  setupResetGuide(root);
  assert.equal(replacement.textContent, "RP2040 RESET");
  assert.equal(replacement.href, "assets/rp2040-reset-pinout.png");
  assert.equal(replacement.rel, "noopener");
});
