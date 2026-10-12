# Coglet diagnostics

A dependency-free USB serial log viewer, diagnostic worksheet, RP2040 motion controls, and Python-file uploader. ESP32 log capture remains read-only and needs no firmware changes.

**Logging** contains the ESP32 connection, captured-log viewer, and diagnostic report. **Motion** contains the RP2040 connection, individual servo controls, and animation previews. **Firmware** uploads selected local `.py` files to the RP2040. Logging opens by default. Switch tabs by clicking, or use Left/Right Arrow, Home, and End while a tab has keyboard focus.

Tabs only change the visible panel: captures, filters, reports, form values, connections, motion heartbeats, and uploads are preserved. Switching away from Motion does **not** stop movement or cancel an upload. **Stop & disable PWM** remains above all tabs, but requires a running motion connection; it is unavailable during a firmware upload. Disconnect the active USB connection before changing the board's Programming Selector.

From the repository root:

```powershell
python -m http.server 8765 --bind 127.0.0.1 --directory .\CogletESP\scripts\diagnostics
```

Open **http://localhost:8765** in desktop Chrome or Edge. Set the board's **Programming Selector to ESP32**, connect its programming USB port, close ESP-IDF Monitor or any other serial monitor, click **Connect Coglet**, and choose its serial port. The console uses 115200 baud. This is not the separate UART link to the RP2040 or its MicroPython REPL.

The log viewer never writes to the ESP32 serial port or deliberately toggles reset signals. Some USB adapters or drivers can reset the board when a port opens. It cannot retrieve historical messages: connect before the event you want to capture. If the selected port stays quiet, check the cable, console connector, and firmware console configuration.

## Physical switches and buttons

These directions use the component-side orientation in the [CogNog V3.0 pinout](https://github.com/user-attachments/assets/3583c5b2-1953-4ada-817a-bcface599220): microphone connector at the top, programming USB port at the bottom. Refer to the labels on your board if its revision differs.

| Slide switch | ESP32 log capture | UI servo / animation testing | What the position means |
| --- | --- | --- | --- |
| Programming Selector, beside the programming USB port | **ESP32** (upper position) | **RP2040** (lower position) | Routes the one shared programming USB port to the selected MCU; it does not select which MCU runs. |
| Calibration Mode / SETUP, bottom left | **OFF** (right, toward NC) for normal behavior | **OFF** (right, toward NC) | Left / ON connects RP GPIO20 to GND and gives physical calibration exclusive servo ownership. USB motion commands are rejected while it is ON. |
| Face Tracking / FACE-TRACK, beside SETUP | **OFF** (right, toward NC) for a stationary tracking baseline; ON only when investigating face tracking | **OFF** (right, toward NC) recommended | Left / ON connects RP GPIO21 to GND and enables Grove face tracking during normal behavior. USB motion previews pause tracking regardless; resuming normal behavior honors this switch. |
| Main Power, larger bottom switch | **ON** (left, as marked) for normal powered operation | **ON** (left, as marked), with the main 5 V supply connected | Programming USB alone can power logic but does not power the servos. Use the datasheet's 5 V / 3 A main supply. |

Calibration and face tracking are active LOW in the current firmware. Turning face tracking OFF does **not** stop ordinary ESP32-driven animations, and turning calibration ON can immediately move all servos to their configured home targets.

All momentary buttons should be **released** during ordinary log capture and UI motion testing:

| Button | When to use it |
| --- | --- |
| Servo Test (RP GPIO12) | Only for physical assembly calibration: with Calibration Mode ON and the mechanism clear, hold it to wiggle enabled servos approximately +/-10 degrees around calibrated home, limited by each servo's configured travel. Release to return home. It does not start a USB animation preview. |
| RP2040 RESET | Briefly press after uploading the MicroPython files to restart the motion firmware. A reset can restore PWM and startup movement; it is not an emergency stop. |
| RP2040 BOOT | Firmware/bootloader recovery only; do not hold it when starting normal diagnostics. |
| ESP BOOT | Flashing or the firmware's normal user-button functions only; leave released for diagnostics. In this firmware, a click can toggle chat, or reset Wi-Fi setup during disconnected startup. |
| ESP RESET | Briefly press only if an ESP32 restart is intended. Leave released during capture unless you specifically want to observe startup logs. |

For physical assembly calibration, set **Calibration ON (left)**, **Face Tracking OFF (right)**, and **Main Power ON (left)** with the main supply connected. Select RP2040 if monitoring its calibration messages over USB. Support the mechanism before enabling calibration or using Servo Test; return Calibration to OFF before using the UI's motion controls.

The board has **one shared programming USB port**. Disconnect the active UI connection before changing the Programming Selector, then reconnect and choose the newly enumerated port. With the onboard port alone, log capture and motion control are used **one at a time**; retained ESP32 logs remain available after switching to RP2040. Simultaneous live ESP32 capture and RP2040 control require an additional, independently wired console interface.

## Servos and animations

Copy the updated `main.py`, `animation.py`, and new `diagnostics_control.py` from `CogletESP\RP2040` onto the RP2040 alongside its existing `servoclass.py` and `vision.py`, then restart it. Use the **Firmware** tab below or Thonny to install them. Close Thonny or any other RP2040 serial monitor. The running main loop accepts motion diagnostics commands over USB stdin; the **Motion** connection does not enter the REPL, send Ctrl+C, or flash firmware.

Disconnect ESP32 log capture, set the **Programming Selector to RP2040**, and set **Calibration Mode OFF**. Use **Connect motion USB** and select the newly enumerated **RP2040** USB port, not the ESP32 console or its motion UART. Connection only queries capabilities: it loads the enabled servos, socket numbers, current requested targets, angle limits, and available animation presets/actions from firmware. Older firmware fails the handshake and leaves motion controls disabled.

Clear the mechanism, support parts that could drop, then check **Enable motion controls**. Choose a servo and target angle and click **Apply servo target**; changing a field does not move anything. Individual moves use the existing listening-ear speed/acceleration as a ceiling. Each command freezes other axes at their interpolated positions and overrides ESP32 motion and face tracking. Targets and acknowledgements are not encoder feedback or proof that a servo moved. The configured limits must already match your assembled, calibrated hardware.

**Play animation** previews an existing expression continuously, or a named two-second action that then holds. **Stop & disable PWM**, unchecking the enable box, or disconnecting motion USB disables PWM and leaves normal motion suspended. This is not a power cut or a hardware emergency stop: the servo rail stays powered, and unpowered linkages may drop. **Resume normal behavior** explicitly returns ownership to the latest ESP32 state and physical face-tracking switch; it can move the robot.

Physical Calibration Mode always wins and cancels a USB override; turn it off before enabling USB controls again. The browser renews active USB overrides once per second. If it closes, crashes, loses the cable, or is throttled for five seconds, firmware disables PWM and stays stopped until another explicit motion/resume command or physical calibration. Heartbeats do not affect normal behavior or extend an override left by an earlier browser session.

The newline-delimited USB protocol is `diag:{"id":1,"command":"hello"}` with responses prefixed `COGLET_DIAG `. Version 1 supports `hello`, `keepalive` (with `renew:true` for active ownership), `servo` (`name`, `angle`), `animation`/`action` (`name`), `stop`, and `resume`. Requests are bounded to 512 characters; servo angles and preset names are validated again on the RP2040. ESP32 logs and diagnostics reports remain separate from motion acknowledgements.

## Upload RP2040 Python files

The **Firmware** tab uses MicroPython's built-in raw USB REPL, so it works **before** `diagnostics_control.py` is installed. MicroPython must already be running on the RP2040 with its USB REPL enabled. This is not an ESP32 updater or a BOOT/UF2 flashing tool. Files transfer directly from the browser to the selected device; the Python HTTP server only serves the UI.

1. Support any linkages that could drop and **physically disconnect the external 5 V servo supply**. Set **Main Power OFF (right)**. Programming USB can power the logic; disabling PWM is not a substitute for removing servo power.
2. Disconnect Logging and Motion, and close Thonny, `mpremote`, and other serial monitors. With no UI connection open, set **Programming Selector RP2040 (lower)**, **Calibration OFF (right)**, and **Face Tracking OFF (right)**. Leave BOOT and Servo Test released.
3. Open Firmware, acknowledge the safety instructions, then click **Connect for upload** and choose the RP2040 USB port. This sends Ctrl+C to interrupt the program and enters raw REPL without a soft reboot. The UI verifies `micropython` / `rp2` before filesystem writes and drives the Coglet board's GPIO8 HIGH to disable PWM. The motion lease and Stop button do not protect a program interrupted in REPL.
4. Choose local Python files. For this update, select **`animation.py`, `diagnostics_control.py`, and `main.py`** from `CogletESP\RP2040`. Leave existing `servoclass.py` and `vision.py` untouched unless intentionally updating them. Only root `.py` filenames containing letters, digits and underscores are accepted. Limits are 16 nonempty UTF-8 files, 96 KiB per file and 256 KiB per batch.
5. Review destinations, explicitly confirm replacement, and click **Upload & verify files**. Keep USB connected and servo power off. Each file is staged in a unique `/_coglet_upload_<id>` folder, checked against the browser's SHA-256 hash, and compiled for syntax without executing its code. **All files must pass before replacement begins.** Syntax checks cannot prove imports, hardware configuration or runtime behavior.
6. The UI replaces verified files, installing **`main.py` last**, and retains each existing file as `<filename>.bak` inside that upload folder. The receipt lists installed filenames, the folder, and backup paths. Backups from earlier uploads are never deliberately overwritten. Free flash must accommodate staged files plus a 4 KiB reserve; backups retain the old files' storage.
7. Click **Disconnect firmware USB**. The board stays interrupted in raw REPL: neither upload nor disconnect restarts it. Clear the mechanism and manually press **RP2040 RESET** when ready. Reset can restore PWM and startup movement. Reconnect external servo power only when safe, then use Motion normally.

Hover over **RP2040 RESET** in the Firmware panel's final instructions to see an annotated board-image overlay. Keyboard focus also opens it; on touch screens, tap the label. The orange outline and arrow mark the physical reset button between **SERVO TEST** and **RP2040 BOOT**, not the ESP reset switch beside the programming port. Escape, Close, or an outside click dismisses the overlay. The guide is informational and sends no command to the board.

The locally served `assets\rp2040-reset-detail.png` and `assets\rp2040-reset-pinout.png` are cropped/annotated derivatives of the [CogNog V3.0 pinout by Will Cogley / NMRobotics](https://github.com/user-attachments/assets/3583c5b2-1953-4ada-817a-bcface599220), linked from the [upstream datasheet](https://github.com/will-cogley/Coglet/blob/main/CogNogDatasheet.md). The overlay also links the full annotated image. Verify your board labels if its revision differs.

Uploads continue across tab switches; connect buttons for Logging and Motion are blocked while firmware USB is reserved, including during the port chooser. Firmware refuses to take over either active connection. Keep the browser open until the receipt appears; do not reload, switch the board selector, reset, or unplug during transfer.

### Failure and recovery

A staging, syntax, SHA-256, or storage failure leaves root files unchanged. The upload folder may retain staged `.new` files. An ordinary replacement error attempts to restore the previous root files and remove newly introduced root files back into staging. A failed rollback is explicitly reported. **A batch is not power-loss atomic:** if USB/power is lost during replacement, or the installation receipt is missing, do not assume the root files are complete.

Keep servo power disconnected. Close the browser connection, open the RP2040 in Thonny, interrupt it if necessary, and use Ctrl+B to leave raw REPL for the friendly prompt. Inspect the reported upload folder and root files before restarting. Copy `.bak` files back to their original root names to restore overwritten files, remove any newly introduced root files you no longer want, or reinstall the complete intended set. Download important backups before deleting any upload folders to reclaim flash.

If the board is not identified as RP2040 MicroPython, no files are written, but the selected console may already have received Ctrl+C. If raw REPL cannot be entered, check the selector, MicroPython installation, USB cable, and whether the program suppresses KeyboardInterrupt or USB REPL. Recover with servo power off; the uploader does not automatically reset a board to overcome this.

## Captured-log diagnostics

**Run diagnostics** analyzes the retained capture for crash/watchdog/brownout indicators, ESP-IDF error and warning levels, SRAM reports, application state, and camera/audio/network messages. Results are evidence, not hardware tests. Warnings can be informational (including the current camera initialization success message); missing messages are **Not observed**, never a healthy result. Reports are snapshots; incoming lines mark them out of date.

Search and severity filters affect the viewer only. **Pause view** freezes display updates while capture continues. **Export log** saves all retained complete lines, regardless of filters. **Clear log** discards the local capture and report without touching the device. Imports replace the local capture and accept text logs up to 2 MiB, even in browsers without Web Serial.

The latest 5,000 nonempty lines are kept in memory. Lines longer than 16,384 characters are truncated; dropped/truncated counts are visible. Diagnostics and exports cover this retained window only. Log data is not sent to a server or stored across reloads; explicitly uploaded firmware files and backups persist on the RP2040. Exports can include conversation transcripts, URLs, or private information; review before sharing.

Run the parser and diagnostics checks with:

```powershell
node --test .\CogletESP\scripts\diagnostics\diagnostics.test.mjs
node --test .\CogletESP\scripts\diagnostics\motion.test.mjs
node --test .\CogletESP\scripts\diagnostics\tabs.test.mjs
node --test .\CogletESP\scripts\diagnostics\firmware.test.mjs
node --test .\CogletESP\scripts\diagnostics\reset-guide.test.mjs
python -B -m unittest discover -s .\CogletESP\RP2040 -p test_diagnostics_control.py
```

Uploader checks use mocked Web Serial and an isolated CPython filesystem for the generated staging, syntax-check, backup and rollback scripts. They require Python on PATH and do not operate physical hardware.
