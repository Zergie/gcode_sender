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
      |- JobService
      |- LiveTuningService
      |- CatalogService ----- approved HTTPS catalog host
      |- PersistenceStore
      +- ActivityService

The renderer has no Node.js integration. Electron runs with context isolation,
sandboxing, a restrictive permission handler, a navigation guard, and a typed
preload bridge.

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

Simulation mirrors the supported firmware's QuickPID 3.1.9 configuration at
100 ms, whole-degree M104 targets, and 8-bit PWM output. The thermal solver uses
a fixed 50 ms RK4 step. Time warp changes result batching/playback only, never
the physical equations, controller units, telemetry frequency, or real-hardware
command speed. The deterministic v1 grid is retained only as an offline output
reference; its non-conservative heater saturation and transfer formulas are not
part of production simulation.

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
