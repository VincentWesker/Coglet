# Coglet diagnostics

A dependency-free, read-only USB serial log viewer and diagnostic worksheet. No firmware changes or commands are required.

From the repository root:

```powershell
python -m http.server 8765 --bind 127.0.0.1 --directory .\CogletESP\scripts\diagnostics
```

Open **http://localhost:8765** in desktop Chrome or Edge. Plug in the **ESP32 console USB connection**, close ESP-IDF Monitor or any other serial monitor, click **Connect Coglet**, and choose its serial port. The console uses 115200 baud. This is not the separate UART link to the RP2040 or its MicroPython REPL.

The UI never writes to the serial port or deliberately toggles reset signals. Some USB adapters or drivers can reset the board when a port opens. It cannot retrieve historical messages: connect before the event you want to capture. If the selected port stays quiet, check the cable, console connector, and firmware console configuration.

**Run diagnostics** analyzes the retained capture for crash/watchdog/brownout indicators, ESP-IDF error and warning levels, SRAM reports, application state, and camera/audio/network messages. Results are evidence, not hardware tests. Warnings can be informational (including the current camera initialization success message); missing messages are **Not observed**, never a healthy result. Reports are snapshots; incoming lines mark them out of date.

Search and severity filters affect the viewer only. **Pause view** freezes display updates while capture continues. **Export log** saves all retained complete lines, regardless of filters. **Clear log** discards the local capture and report without touching the device. Imports replace the local capture and accept text logs up to 2 MiB, even in browsers without Web Serial.

The latest 5,000 nonempty lines are kept in memory. Lines longer than 16,384 characters are truncated; dropped/truncated counts are visible. Diagnostics and exports cover this retained window only. Nothing is uploaded or stored across reloads. Exports can include conversation transcripts, URLs, or private information; review before sharing.

Run the parser and diagnostics checks with:

```powershell
node --test .\CogletESP\scripts\diagnostics\diagnostics.test.mjs
```
