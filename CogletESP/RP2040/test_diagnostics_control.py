import contextlib
import importlib.util
import io
import json
from pathlib import Path
import time
import types
import unittest
from unittest.mock import patch

from diagnostics_control import DiagnosticsControl, PREFIX


class FakeServo:
    def __init__(self, pin_num, max_speed, max_accel, min_angle, max_angle):
        self.port_num = pin_num
        self.max_speed = max_speed
        self.max_accel = max_accel
        self.min_angle = min_angle
        self.max_angle = max_angle
        self.enabled = True
        self.pos = min(max(90, min_angle), max_angle)
        self.target = self.pos
        self.vel = 0

    def set_target(self, angle):
        self.target = min(max(angle, self.min_angle), self.max_angle)

    def set_immediate(self, angle):
        self.set_target(angle)
        self.pos = self.target
        self.vel = 0

    def update(self, dt):
        pass


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.now = 100
        for name, function in (
            ("ticks_ms", lambda: self.now),
            ("ticks_us", lambda: self.now * 1000),
            ("ticks_diff", lambda a, b: a - b),
            ("ticks_add", lambda a, b: a + b),
        ):
            self.stack.enter_context(patch.object(time, name, function, create=True))
        self.stack.enter_context(patch.dict("sys.modules", {
            "servoclass": types.SimpleNamespace(Servo=FakeServo),
        }))
        spec = importlib.util.spec_from_file_location(
            "test_animation", Path(__file__).with_name("animation.py")
        )
        self.animation = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.animation)
        self.outputs = True
        self.responses = []
        self.control = DiagnosticsControl(
            self.animation, self.enable, self.disable,
            lambda line: self.responses.append(json.loads(line[len(PREFIX):])),
        )

    def enable(self, reason):
        self.outputs = True
        return True

    def disable(self):
        self.outputs = False

    def request(self, command, calibrating=False, **fields):
        self.control.handle(json.dumps({"id": 1, "command": command, **fields}),
                            self.now, calibrating)
        return self.responses[-1]

    def test_hello_reports_real_limits_without_moving(self):
        targets = [servo.target for servo in self.animation.servos.values()]
        reply = self.request("hello")
        self.assertEqual(reply["service"], "coglet-motion")
        self.assertEqual(len(reply["servos"]), 9)
        pitch = next(servo for servo in reply["servos"] if servo["name"] == "PIT")
        self.assertEqual((pitch["socket"], pitch["min"], pitch["max"]), (8, 1, 80))
        self.assertEqual(targets, [servo.target for servo in self.animation.servos.values()])
        self.assertIsNone(self.control.mode)

    def test_invalid_requests_do_not_change_ownership_or_targets(self):
        for name, angle in (
            ("PIT", 81), ("MOU", -1), ("YAW", float("nan")),
            ("YAW", True), ("missing", 90),
        ):
            with self.subTest(name=name, angle=angle):
                self.assertFalse(self.request("servo", name=name, angle=angle)["ok"])
                self.assertIsNone(self.control.mode)
        for command, name in (("animation", "state_limber_up"), ("action", "unknown")):
            self.assertFalse(self.request(command, name=name)["ok"])
        self.control.handle("[]", self.now, False)
        self.assertFalse(self.responses[-1]["ok"])
        self.control.handle("{", self.now, False)
        self.assertFalse(self.responses[-1]["ok"])

    def test_manual_target_freezes_other_axes_and_caps_speed(self):
        mouth = self.animation.servos["MOU"]
        mouth.vel = 30
        self.assertTrue(self.request("servo", name="MOU", angle=20)["ok"])
        self.assertEqual(mouth.target, 20)
        self.assertEqual(mouth.vel, 0)
        self.assertEqual(mouth.max_speed, self.animation.LISTENING_EAR_MAX_SPEED)
        self.assertEqual(mouth.max_accel, self.animation.LISTENING_EAR_MAX_ACCEL)
        self.assertTrue(all(s.target == s.pos for n, s in self.animation.servos.items() if n != "MOU"))
        self.assertTrue(self.control.update(self.now, False))

    def test_stop_latches_until_explicit_resume(self):
        self.request("animation", name="speaking")
        self.control.update(self.now, False)
        self.assertTrue(self.request("stop")["ok"])
        self.assertFalse(self.outputs)
        self.assertTrue(self.control.update(self.now + 10000, False))
        self.assertEqual(self.control.mode, "stopped")
        self.request("resume")
        self.assertTrue(self.outputs)
        self.assertFalse(self.control.update(self.now, False))
        self.assertTrue(self.animation.new_state_flag)

    def test_lease_expiry_stops_and_unowned_heartbeats_do_not_renew(self):
        self.request("servo", name="YAW", angle=100)
        self.now += 4999
        self.request("keepalive", renew=False)
        self.control.update(self.now, False)
        self.assertTrue(self.outputs)
        self.now += 1
        self.control.update(self.now, False)
        self.assertFalse(self.outputs)
        self.assertEqual(self.responses[-1]["event"], "timeout")
        self.request("servo", name="YAW", angle=90)
        self.now += 4000
        self.request("keepalive", renew=True)
        self.control.update(self.now + 4999, False)
        self.assertTrue(self.outputs)
        self.control.update(self.now + 5000, False)
        self.assertFalse(self.outputs)

    def test_calibration_rejects_commands_and_cancels_override(self):
        self.request("servo", name="YAW", angle=100)
        self.assertFalse(self.request("servo", calibrating=True, name="YAW", angle=90)["ok"])
        self.assertFalse(self.request("stop", calibrating=True)["ok"])
        self.assertFalse(self.control.update(self.now, True))
        self.assertIsNone(self.control.mode)
        self.assertEqual(self.responses[-1]["event"], "calibration")
        self.assertTrue(self.outputs)

    def test_presets_reuse_real_animation_and_keep_normal_state(self):
        self.animation.current_state = "listening"
        self.request("animation", name="sad")
        self.control.update(self.now, False)
        self.assertEqual(self.animation.servos["PIT"].target, self.animation.SAD_PITCH_ANGLE)
        self.assertEqual(self.animation.current_state, "listening")
        self.request("action", name="shake_head")
        self.assertTrue(self.animation.mcp_action_active())
        self.control.update(self.now + 2000, False)
        self.assertFalse(self.animation.mcp_action_active())
        self.assertEqual(self.control.mode, "servo")

    def test_usb_line_bound_and_chunked_crlf(self):
        line = 'diag:{"id":2,"command":"hello"}\r\n'
        for char in line:
            self.control.feed(char, self.now, False)
        self.assertEqual(len(self.responses), 1)
        self.assertEqual(self.responses[0]["id"], 2)
        for char in "diag:" + "x" * 600 + "\n":
            self.control.feed(char, self.now, False)
        self.assertFalse(self.responses[-1]["ok"])
        self.assertEqual(self.control.line, "")

    def run_main_loop(self, usb_command="", calibrating=False):
        class EndLoop(Exception):
            pass

        class FakePin:
            IN, OUT, PULL_UP = 0, 1, 2

            def __init__(self, number, *args):
                self.number = number

            def value(self, value=None):
                if value is not None:
                    return
                return 0 if self.number == 20 and calibrating else 1

        class FakeUART:
            def __init__(self, *args, **kwargs):
                self.data = b"speaking\naction:ears\n"

            def any(self):
                return bool(self.data)

            def read(self):
                data, self.data = self.data, b""
                return data

        class FakeFollower:
            def __init__(self, servos):
                self.enabled = None

            def release_to_home(self):
                pass

            def update(self, now, state, enabled):
                self.enabled = enabled

        stdin = io.StringIO(usb_command)

        class FakePoll:
            def register(self, *args):
                pass

            def poll(self, timeout):
                return [1] if stdin.tell() < len(usb_command) else []

        def finish(delay):
            raise EndLoop()

        hardware = types.SimpleNamespace(
            Servo=FakeServo, is_ready=lambda: True,
            enable_outputs=lambda: self.enable("main"),
            disable_outputs=self.disable,
        )
        namespace = {}
        with patch.dict("sys.modules", {
            "machine": types.SimpleNamespace(Pin=FakePin, UART=FakeUART),
            "servoclass": hardware, "animation": self.animation,
            "vision": types.SimpleNamespace(EyeFollower=FakeFollower),
            "urandom": types.SimpleNamespace(),
            "uselect": types.SimpleNamespace(poll=FakePoll, POLLIN=1),
        }), patch("sys.stdin", stdin), patch.object(time, "sleep_ms", finish, create=True):
            with self.assertRaises(EndLoop):
                exec(compile(Path(__file__).with_name("main.py").read_text(encoding="utf-8"),
                             "main.py", "exec"), namespace)
        return namespace

    def test_main_stop_blocks_uart_wake_and_competing_animation(self):
        main = self.run_main_loop('diag:{"id":1,"command":"stop"}\n')
        self.assertEqual(main["diagnostics"].mode, "stopped")
        self.assertFalse(self.outputs)
        self.assertEqual(self.animation.current_state, "speaking")
        self.assertFalse(self.animation.mcp_action_active())
        self.assertFalse(main["eye_follower"].enabled)
        self.assertTrue(all(s.target == s.pos for s in self.animation.servos.values()))

    def test_main_without_usb_override_preserves_uart_actions(self):
        main = self.run_main_loop()
        self.assertIsNone(main["diagnostics"].mode)
        self.assertTrue(self.outputs)
        self.assertTrue(self.animation.mcp_action_active())

    def test_main_physical_calibration_keeps_home_and_rejects_usb(self):
        main = self.run_main_loop('diag:{"id":1,"command":"servo","name":"YAW","angle":120}\n',
                                  calibrating=True)
        self.assertIsNone(main["diagnostics"].mode)
        self.assertTrue(self.outputs)
        for name, servo in self.animation.servos.items():
            self.assertEqual(servo.target, min(max(self.animation.pose_calibrate[name],
                                                 servo.min_angle), servo.max_angle))


if __name__ == "__main__":
    unittest.main()
