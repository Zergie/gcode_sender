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
  enclosure/safety sensor;
- the existing pid_temp_with_gcode_stm32 firmware at fixed 115200 baud;
- Marlin-leaning, line-oriented G-code without assuming full Marlin flow
  control.

The firmware is out of scope for this repository. There is no required v2
firmware. The desktop never sends M500, because persistence in the current
firmware cannot be treated as reliable.

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
- Deterministic dual-zone oven simulation with 1x, 5x, 20x, 100x, and maximum
  time warp.
- PID-only and model-assisted PID control modes. Model-assisted mode shapes the
  firmware target; the firmware always owns the actuator loop.
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
- npm 12 or newer.

Install and start:

    npm install
    npm start

Useful commands:

    npm run build
    npm test
    npm run lint
    npm run format:check
    npm run rebuild:native
    npm run package
    npm run make

npm start runs the Angular development server and Electron together.
npm run package creates an unpacked Windows application; npm run make creates
the configured Windows installer.

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
