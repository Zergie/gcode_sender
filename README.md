# GCode Sender v2

GCode Sender is a cross-platform Electron + Angular workstation for the
[pid_temp_with_gcode_stm32](https://github.com/Zergie/pid_temp_with_gcode_stm32)
oven controller. It combines live thermal monitoring, manual G-code, streamed
jobs, deterministic oven simulation, gain-scheduled PID profiles, model-assisted
control, and supervised live PID calibration.

> [!WARNING]
> This desktop application is not a safety controller. Heater-off and Stop are
> best effort. Disconnect intentionally closes the link without issuing a
> heater-off command; the STM32 firmware and its watchdogs are the only safety
> authority. Always supervise live heating.

## Supported hardware

v2 intentionally supports one hardware configuration:

- two physical heaters (top and bottom) sharing one GPIO / actuator;
- three thermistors, where T0 is the T1/T2 average and T3 is the
  T3 enclosure sensor;
- the existing pid_temp_with_gcode_stm32 firmware at fixed 115200 baud;
- Marlin-leaning, line-oriented G-code without assuming full Marlin flow
  control.

The firmware is out of scope for this repository. There is no required v2
firmware. The desktop never sends M500, because persistence in the current
firmware cannot be treated as reliable.

### T3 terminology

T3 is the independent thermistor exposed at the enclosure boundary. The
canonical operator term is **T3 enclosure sensor**: temperature measured by
the externally exposed enclosure thermistor; informational only. `T3` remains
the stable firmware telemetry channel and is not renamed or remapped.

The desktop application is not a safety controller. T3 readings and
host-side experiment-integrity alerts do not provide an interlock or other
safety enforcement; the STM32 firmware and its watchdogs remain the safety
authority. Existing telemetry, profiles, retained sessions, and exports keyed
by `T3` remain readable, while new human-facing output uses the canonical term.

## Highlights

- Dashboard with T0–T3, target, power, connection state, and live trends.
- Terminal with command history, telemetry, and a bundled 451-command catalog.
- Streaming for .gcode, .gco, .gc, and .txt files, with completion-aware
  pacing, pause/resume, explicit retry/continue/stop decisions, restart-line
  logging, and no automatic resume after a disconnect.
- Portable heating profiles created and edited on the Dashboard. Profiles are
  saved as ordinary `.gcode` files with a versioned comment header, render as
  an editable planned-temperature overlay, and run through the same streaming
  path as every other G-code file.
- Energy-conserving physical oven twin with explicit heater, air, Standard-load,
  enclosure, and thermistor bodies; deterministic 1x, 5x, 20x, 100x, and
  maximum time warp.
- Firmware-in-the-loop simulation for the supported Arduino `.ino`
  sketch. The app compiles a content-addressed WebAssembly snapshot, exposes
  configurable virtual STM32 GPIO mapping and EEPROM with the supported
  board's fixed 12-bit ADC output, and derives heater duty from the firmware's
  actual output-pin high time. ARM `.bin` files are intentionally not accepted
  because they require CPU/peripheral emulation.
- Firmware-faithful QuickPID cadence and quantized shared PWM. PID-only and
  model-assisted PID modes both leave the actuator loop in firmware;
  model-assisted control observes the live twin state and selects a bounded
  whole-degree M104 target by forecasting physical T1/T2 tracking.
- Target-temperature PID breakpoints with interpolation and paced M301
  updates.
- Supervised live-heater tuning based on Klipper's relay-peak method, adapted to
  this firmware's target-only interface. Results remain drafts until explicitly
  applied and are never persisted with M500.
- Versioned profiles, session retention, pinning, and JSON import/export.
- Firmware command-catalog refresh over approved HTTPS hosts with validation,
  a 24-hour cache, and bundled fallback.
- Dark, light, and system themes with a responsive 900x600 minimum layout.

## Application layout

The navigation order is Dashboard, Terminal, Jobs, Simulation, Tuning &
Profiles, Settings, and About.

The startup macro is optional and empty by default. A serial port is never
opened automatically; choose a port and connect manually. Disconnect remains
available at all times.

### Heating-profile G-code

Heating profiles remain portable files rather than entries in the application's
JSON profile store. Their leading semicolon comments preserve the profile name
and time/temperature points for round-trip editing. The executable body uses
only `M104` target changes and bounded `G4` dwell commands supported by the
current STM32 firmware, and ends with `M104 S0`.

Loading an ordinary G-code file without this metadata still selects it as a
runnable job; the application does not rewrite it or invent an editable graph.
Malformed profile metadata is shown as a warning while the original file
remains available to stream unchanged. Generated dwells are no longer than five
seconds, which bounds—but cannot eliminate—the firmware's uninterruptible `G4`
window.

## Development

Requirements:

- Windows 10/11 for the verified development and packaging workflow;
- Node.js 24.19 or newer;
- npm 11 or newer.

The archive-security gate is reproducible locally with `npm run verify:archive-security`.
It inspects the complete locked dependency graph, evaluates `npm audit` high and critical
findings (including development dependencies), and validates any reviewed exceptions in
`scripts/archive-security-exceptions.json`. The command exits nonzero for vulnerable
archive paths, unmatched audit findings, expired exceptions, or incomplete exception
records. Use `--audit-report <path>` with `scripts/archive-security-gate.mjs` for
deterministic offline evaluation of a captured npm audit report.

Firmware-in-the-loop builds use bundled, version-checked GCodeParser 1.3.0,
NTC_Thermistor 2.1.0, and QuickPID 3.1.9 sources. They additionally require
either local Emscripten `em++` 4.0.20 or Docker with the pinned official image:

    docker pull emscripten/emsdk:4.0.20@sha256:460fff8f8ac87e11b16447fbd66538a686eafa0e4fb977aa0989ed19fe2079f7

The Simulation page reports these capabilities before opening a sketch.
Arduino CLI, the STM32 core, and separately installed Arduino libraries are not
used by this source-level adapter. A compiled firmware snapshot is required to
run the physical twin; there is no built-in controller fallback.

Install and start:

    npm install
    npm start

Useful commands:

    npm run build
    npm test
    npm run lint
    npm run format:check
    npm run test:browser
    npm run rebuild:native
    npm run package
    npm run make
    npm run verify:windows-package

npm start runs the Angular development server and Electron together.
npm run test:browser runs the deterministic renderer-only responsive harness
without Electron or serial hardware. It covers light and dark themes at the
900×600 minimum viewport and a 1280×800 desktop viewport; failures retain
geometry, DOM, and screenshot diagnostics in the Playwright report.
The same command runs in the required `Responsive browser gate` pull-request
workflow, which installs Chromium from the locked dependency set and uploads
the Playwright report and failure diagnostics for seven days when a case fails.
npm run package creates an unpacked Windows application; npm run make creates
the configured Windows installer. `npm run verify:windows-package` runs both
packaging commands, validates the unpacked app's Electron, native serial, and
bundled firmware resources, and launches it with an isolated profile for a
bounded smoke check. It is Windows-only and retains no artifacts unless the
script is invoked with `-KeepArtifacts`.

Electron Forge also contains macOS ZIP and Linux DEB/RPM makers. Those targets
are kept portable in the source, but this release was tested only on Windows
and is not signed or notarized.

## Design boundaries

- Electron's renderer is sandboxed and communicates through a typed preload API;
  serial and filesystem access stay in the main process.
- A single exclusive activity lane prevents job streaming and live tuning from
  issuing overlapping machine commands.
- Time warp advances simulation time only. It never accelerates commands sent to
  physical hardware.
- Firmware WebAssembly runs in the simulation worker with deterministic virtual
  time and an allowlisted, semantic Arduino/STM32 peripheral layer. It has no
  filesystem, network, host-clock, entropy, real serial, or real GPIO access.
  This executes the sketch's source-level logic; it is not Cortex-M instruction
  or register-level emulation. UART bytes retain deterministic order, but ABI
  v1 does not model 115200-baud serialization, native FIFO blocking, or
  instruction-cycle timing. Heavy UART traffic is therefore not cycle-accurate;
  buffer saturation aborts the simulation instead of discarding output.
- Feed-forward is exposed as model-assisted PID correction, not uncontrolled
  open-loop heater power.
- A live tune snapshots firmware gains using M503, validates reported output,
  gathers 12 alternating peaks, derives draft candidates, sets M104 S0, and
  restores prior gains when the protocol permits. A cable pull or application
  crash can still prevent rollback.
- Unknown job-command timeouts require an explicit operator decision.
- G-code files are streamed as provided after comment/blank-line normalization;
  they are not semantically preflighted.
- Starting a file job disarms desktop target control so a previously armed
  target cannot resume after a heating profile completes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module and protocol design.

## Privacy and network access

The app has no updater and does not send telemetry. Its only intended network
operation is an operator-approved HTTPS command-catalog fetch from the URL
reported by firmware. Cached and bundled catalogs keep the terminal usable
offline.

## License and attribution

GCode Sender is licensed under [GPL-3.0-or-later](LICENSE). The live tuning
method is derived from Klipper's pid_calibrate.py; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright © 2026 Wolfgang Puchinger and contributors.
