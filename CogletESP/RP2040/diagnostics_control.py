import json
import time


PREFIX = "COGLET_DIAG "
LEASE_MS = 5000


class DiagnosticsControl:
    """USB-only, leased motion ownership; physical calibration always wins."""

    def __init__(self, animation, enable, disable, emit=print):
        self.animation = animation
        self.enable = enable
        self.disable = disable
        self.emit = emit
        self.mode = None
        self.preset = None
        self.last_contact = 0
        self.line = ""
        self.overflow = False

    def reply(self, payload):
        self.emit(PREFIX + json.dumps(payload))

    def freeze(self, now):
        self.animation.cancel_mcp_action(now)
        self.animation.update_blink(now, self.animation.current_state, enabled=False)
        self.animation.reset_servo_motion_defaults()
        for servo in self.animation.servos.values():
            if servo.enabled:
                servo.vel = 0
                servo.set_target(servo.pos)
        self.animation.new_state_flag = True

    def stop(self, now):
        self.disable()
        self.freeze(now)
        self.mode = "stopped"
        self.preset = None

    def feed(self, char, now, calibrating):
        if char in "\r\n":
            if self.overflow:
                self.reply({"ok": False, "error": "Command exceeds 512 characters"})
            elif self.line.startswith("diag:"):
                self.handle(self.line[5:], now, calibrating)
            self.line = ""
            self.overflow = False
        elif not self.overflow:
            if len(self.line) >= 512:
                self.line = ""
                self.overflow = True
            else:
                self.line += char

    def handle(self, text, now, calibrating):
        request_id = None
        try:
            request = json.loads(text)
            if not isinstance(request, dict):
                raise ValueError("Expected a JSON object")
            request_id = request.get("id")
            if type(request_id) is not int or not 1 <= request_id <= 2147483647:
                raise ValueError("Invalid request ID")
            command = request.get("command")
            response = {"id": request_id, "ok": True}
            if command == "hello":
                response.update({
                    "service": "coglet-motion", "version": 1,
                    "leaseMs": LEASE_MS,
                    "servos": [
                        {"name": name, "socket": servo.port_num,
                         "min": servo.min_angle, "max": servo.max_angle,
                         "target": servo.target}
                        for name, servo in self.animation.servos.items()
                        if servo.enabled
                    ],
                    "animations": [
                        name for name in self.animation.state_map
                        if name not in ("state_startup", "state_limber_up")
                    ],
                    "actions": list(self.animation.MCP_ACTION_NAMES),
                })
            elif command == "keepalive":
                if request.get("renew") is True:
                    self.last_contact = now
            elif calibrating:
                raise ValueError("Physical Calibration Mode owns the servos; turn it off first")
            elif command == "stop":
                self.stop(now)
            elif command == "resume":
                self.freeze(now)
                if not self.enable("diagnostics resume"):
                    raise ValueError("PCA9685 outputs could not be enabled")
                self.mode = None
                self.preset = None
            elif command in ("servo", "animation", "action"):
                name = request.get("name")
                if command == "servo":
                    servo = self.animation.servos.get(name)
                    angle = request.get("angle")
                    if servo is None or not servo.enabled:
                        raise ValueError("Unknown or disabled servo")
                    if type(angle) not in (int, float) or not servo.min_angle <= angle <= servo.max_angle:
                        raise ValueError("Angle is outside this servo's firmware limits")
                elif command == "animation":
                    if name not in self.animation.state_map or name in ("state_startup", "state_limber_up"):
                        raise ValueError("Unknown animation")
                elif name not in self.animation.MCP_ACTION_NAMES:
                    raise ValueError("Unknown action")
                self.freeze(now)
                if not self.enable("USB diagnostics"):
                    raise ValueError("PCA9685 outputs could not be enabled")
                self.last_contact = now
                self.preset = name
                self.mode = command
                if command == "servo":
                    servo.max_speed = min(servo.max_speed, self.animation.LISTENING_EAR_MAX_SPEED)
                    servo.max_accel = min(servo.max_accel, self.animation.LISTENING_EAR_MAX_ACCEL)
                    servo.set_target(angle)
                elif command == "action":
                    self.animation.start_mcp_action(name, now)
            else:
                raise ValueError("Unknown diagnostics command")
            response.update({"mode": self.mode, "calibrating": calibrating})
            self.reply(response)
        except (ValueError, TypeError, KeyError) as error:
            self.reply({"id": request_id, "ok": False, "error": str(error)})

    def update(self, now, calibrating):
        if calibrating:
            if self.mode is not None:
                self.freeze(now)
                self.mode = None
                self.preset = None
                self.reply({"event": "calibration", "calibrating": True, "mode": None})
            return False
        if self.mode is None:
            return False
        if self.mode != "stopped" and time.ticks_diff(now, self.last_contact) >= LEASE_MS:
            self.stop(now)
            self.reply({"event": "timeout", "mode": "stopped"})
        if self.mode == "animation":
            self.animation.apply_state(self.preset)
            self.animation.update_blink(now, self.preset, enabled=True)
            self.animation.update_speaking_mouth(now, self.preset == "speaking")
        elif self.mode == "action":
            if not self.animation.update_mcp_action(now):
                self.freeze(now)
                self.mode = "servo"
        return True
