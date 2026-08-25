# Architecture

## Process boundary

    Angular renderer
      | typed window.gcode API
      v
    sandboxed Electron preload
      | validated IPC channels
      v
    Electron main process
      |- SerialService ------ STM32 UART at 115200
      |- FirmwareBuildService - .ino snapshot / WebAssembly cache
      |- JobService
      |- LiveTuningService
      |- CatalogService ----- approved HTTPS catalog host
      |- PersistenceStore
      +- ActivityService

The renderer has no Node.js integration. Electron runs with context isolation,
sandboxing, a restrictive permission handler, a navigation guard, and a typed
preload bridge.

## Firmware in the loop

Firmware-in-the-loop replaces only the simulated controller and virtual MCU
I/O; it cannot mutate thermal state directly. Electron snapshots a selected
Arduino sketch directory, applies source and size limits, resolves the supported
libraries from bounded immutable snapshots of the bundled, version-checked
sources, and compiles a content-addressed WebAssembly artifact. Compilation
uses argument-array process spawning and preferably the pinned official
Emscripten container; an exact local Emscripten 4.0.20 is the fallback. Cache
identity includes source, compiler, compatibility shim, library versions,
library content hashes, and ABI. Cache manifests retain build diagnostics and
verify artifact digests before reuse.

The existing Simulation worker instantiates the artifact once per isolated
comparison variant. The `arduino-fil-wasm-v1` boundary supplies only virtual
microsecond time, ADC/digital inputs, UART bytes, EEPROM, and observable output
pins. PA6, PA0, and PA5 receive fixed 12-bit inverse-B3950-divider ADC counts from physical
T1, T2, and T3; PA10/PA9 form the command UART; PC13 is an observable active-low
indicator; and PB9 high-time is edge-integrated into the one shared physical
heater duty. The physical twin then advances using that measured duty. No
delay, noise, oscillation, or other response waveform is added by this layer.
Configured heater and indicator pins must be driven through
`pinMode(..., OUTPUT)` by the firmware; otherwise the run fails instead of
interpreting a reset-default LOW as a real output. Pins marked ignored are not
polled.

Virtual time is independent of wall time and time warp. A virtual reset creates
a fresh Wasm instance and preserves only the configured EEPROM image. The
configured capacity is enforced inside `EEPROM.read`/`write`; ABI v1 requires at
least 33 bytes because the supported sketch addresses byte 32. Wasm
imports are rejected, memory and event counts are bounded, and a trap aborts
the thermal run rather than continuing with the last heater output.

The initial source adapter deliberately supports the existing STM32duino sketch
and its used Arduino APIs: GPIO/ADC, HardwareSerial, HardwareTimer, EEPROM,
`millis`/`micros`, reset, QuickPID, GCodeParser, and NTC_Thermistor. It is
source-level semantic peripheral emulation, not arbitrary Arduino support or
STM32/Cortex-M emulation. Blocking `delay()` is rejected as an unsupported
peripheral behavior because ABI v1 cannot advance it cooperatively without
bypassing timer callbacks or the host step budget. A compiled `.bin` is
therefore outside this adapter. UART byte order is deterministic, but ABI v1
does not synthesize 115200-baud serialization, native FIFO blocking, or
instruction-cycle timing. Heavy UART traffic is not cycle-accurate; a saturated
virtual TX buffer terminates the run explicitly.

## Control model

The supported oven has two heater elements sharing one output, so the
application models one logical actuator and two thermal zones. T1 and T2 are
the control thermistors, T0 is their firmware-provided average, and T3 is
presented as the independent safety/enclosure sensor.

The firmware remains responsible for PID, PWM, and all safety behavior.
PID-only mode sends the requested target. Model-assisted mode maintains a
telemetry-corrected twin state, advances its hidden thermal bodies with the
reported PWM, and forks that state to evaluate bounded whole-degree M104
candidates with the firmware-faithful QuickPID model. The selected command
minimizes predicted T1/T2 tracking error against the unmodified requested
trajectory; firmware PID remains the correction loop. Sensor assimilation is
an explicit observer operation and begins a new energy-ledger epoch rather than
pretending the correction was physical heat flow. PID gain schedules are
interpolated by requested target and applied with paced M301 commands.
Live and offline model-assisted paths share a five-second forecast cadence and
replan immediately when the requested target changes.

The physical twin contains explicit top and bottom heater bodies, top and
bottom chamber air, the Standard load, enclosure, and all three thermistor
bodies. Electrical input, pairwise conduction/convection, T^4 radiation, room
air exchange, and enclosure loss are integrated conservatively. Heater and
sensor response therefore emerge from heat capacity and transfer paths: the
profile contains no delay, response-time, noise, or oscillation controls. An
energy ledger exposes numerical conservation error.

Simulation executes the selected firmware snapshot, including its QuickPID
configuration, whole-degree M104 handling, and PWM output. The thermal solver
uses a fixed 50 ms RK4 step. Time warp changes result batching/playback only,
never the physical equations, controller units, telemetry frequency, or
real-hardware command speed. There is no built-in controller fallback. The
deterministic v1 grid is retained only as an offline output reference; its
non-conservative heater saturation and transfer formulas are not part of
production simulation.

## Protocol adapter

The current firmware is Marlin-like, not a complete Marlin host protocol:

- commands are LF-terminated;
- M104 and M301 return ok;
- M105, M115, and M503 return data without a final ok;
- no checksums, line numbering, or resend protocol are assumed;
- telemetry is T0:<avg> /<target> @:<power> T1:<temp> T2:<temp> T3:<temp>;
- firmware ERROR: lines enter the application fault stream.

Serial parsing and completion policy are centralized in the main process. A
generation token prevents a cancelled connection attempt from reopening or
mutating a newer connection.

## Live tuning

The live calibration flow is an adaptation of Klipper's relay-peak method for a
firmware without direct power control:

1. acquire the exclusive tuning lane;
2. require M503 and snapshot P/I/D;
3. apply high proportional gain with zero I/D;
4. alternate M104 between the calibration target and target minus hysteresis;
5. verify reported output approaches 255/0 and collect 12 peaks;
6. derive a Klipper-style Ziegler-Nichols candidate and a conservative
   alternative;
7. return draft breakpoints only;
8. send M104 S0 and restore the snapshot when acknowledgement permits.

The application never sends M500. Cancellation and rollback are best effort;
firmware watchdogs are the sole safety authority.

## Jobs and command ownership

Manual terminal input, job streaming, tuning, and control writes carry an
origin. The activity service serializes exclusive work. A job is normalized
line by line without reading the entire file or attempting semantic validation.
The current firmware's completion behavior drives pacing. Ambiguous timeouts
pause the job and require Retry, Continue, or Stop. Reconnection never resumes a
job automatically.

Heating-profile documents form a portable layer above the same job streamer.
A shared document module validates time/temperature points, serializes a
versioned semicolon-comment header, and deterministically compiles the profile
to `M104` and short `G4` commands followed by `M104 S0`. The Electron file
adapter reads only a bounded prefix for ordinary files; a marked, size-bounded
profile may be read fully to verify that its editable metadata and executable
body agree. A missing or invalid profile header never turns into a semantic
preflight of arbitrary G-code.

The Dashboard owns only the editable draft and the loaded-file state. Running
both generated profiles and unrelated G-code crosses the existing path-based
JobService interface, preserving one source of truth for pacing, activity
ownership, timeout decisions, logging, and cancellation.

## Persistence

Settings, profiles, sessions, job logs, catalog cache, and tuning traces live
under Electron's per-user data directory. Schemas are versioned and validated at
the process boundary. Sessions retain the latest 100 entries or 90 days unless
pinned; profiles remain until explicitly deleted.

Legacy v1 localStorage is intentionally not migrated.
