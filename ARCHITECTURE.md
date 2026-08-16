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
PID-only mode sends the requested target. Model-assisted mode uses the
deterministic oven model to shape a bounded, wall-clock-paced M104 target and
allows firmware PID to correct model error. PID gain schedules are interpolated
by requested target and applied with paced M301 commands.

Simulation uses a fixed virtual timestep. Time warp changes the number of
virtual steps per wall-clock update, not controller units, telemetry frequency,
or real-hardware command speed. Oven profiles are behind an internal interface
so additional models can be added later; v2 ships one reference model.

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
