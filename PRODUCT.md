# Coglet diagnostics

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain HTML, CSS, and JavaScript, selected by the user. Web Serial connects directly to the USB serial console in Chrome or Edge.

## Product Purpose

Connect to Coglet, view its serial logs, and run diagnostics against captured messages.

## Operating Context

Coglet is a DIY desktop robot companion. Its ESP32 firmware logs to the console at 115200 baud. The ESP32-to-RP2040 motion UART is a separate connection, not the diagnostics console.

## Capabilities and Constraints

The user selected read-only log analysis with no firmware changes. Diagnostics report observed messages, not live hardware health. Missing subsystem evidence must remain unknown. The UI does not send commands, move servos, reset the device, or change configuration.

Logs remain in the browser. Exports can contain conversation transcripts or other private information. Web Serial requires a secure context and user-selected serial port.

## Evidence on Hand

`CogletESP/main/system_info.cc` emits free and minimum SRAM reports. `CogletESP/main/application.cc` emits state changes. Camera, audio, and network components emit tagged ESP-IDF messages.
