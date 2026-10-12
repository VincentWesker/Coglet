# Coglet diagnostics

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain HTML, CSS, and JavaScript, selected by the user. Web Serial connects directly to the USB serial console in Chrome or Edge.

## Product Purpose

Connect to Coglet, review captured serial logs, control RP2040 motion, and explicitly install local Python firmware files.

## Operating Context

Coglet is a DIY desktop robot companion. Its ESP32 firmware logs to the console at 115200 baud. The ESP32-to-RP2040 motion UART is a separate connection, not the diagnostics console.

## Capabilities and Constraints

ESP32 log analysis remains read-only. Diagnostics report observed messages, not live hardware health. Missing subsystem evidence must remain unknown. Log capture and motion controls do not reset the device or change persistent configuration.

Motion controls use a separate, explicitly selected RP2040 USB connection and require the updated MicroPython firmware. The user must enable controls before applying individual servo targets, previewing existing animations/actions, or resuming normal behavior. Servo limits come from firmware; acknowledgement is not measured position feedback. Physical Calibration Mode has priority. Stop disables PWM, not the servo power rail; an active USB override also disables PWM after five seconds without its heartbeat.

The Firmware tab uses the existing MicroPython USB REPL, including before diagnostics firmware is installed. Entering it requires explicit acknowledgement that external servo power is disconnected and interrupts the running program. Logging and Motion must disconnect first. Selected root Python files require separate replacement consent; transfers are staged, SHA-256 and syntax checked, and existing files backed up on the device, with main.py installed last. Replacement errors attempt rollback, but power/USB loss may require manual recovery. Uploads never execute the selected files or automatically restart the board. This is not UF2 flashing or an ESP32 updater.

Logs remain in the browser. Exports can contain conversation transcripts or other private information. Web Serial requires a secure context and user-selected serial port.

## Evidence on Hand

`CogletESP/main/system_info.cc` emits free and minimum SRAM reports. `CogletESP/main/application.cc` emits state changes. Camera, audio, and network components emit tagged ESP-IDF messages.
