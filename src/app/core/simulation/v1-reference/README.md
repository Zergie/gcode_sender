# V1 simulation characterization reference

This directory is an offline, deterministic port of `dummy-mcu/simulation.js`
from commit `56e7583`. It exists only to characterize the output that users
recognized as the v1 simulation. Production simulation code must not import it.

The port deliberately retains the old numerical formulas and their defects:

- a 24 x 52 x 20 explicit diffusion grid with a fixed 0.1 s step;
- the original material-selection precedence and in-place convection writes;
- the nonlinear `max(0, sin(duty) + duty / 2 - 0.25)` actuator gain;
- heater energy divided by the heat capacity of 5 mm air cells, even though the
  heated cells are normally classified as steel;
- the 1,200 C heater-cell cap and the sensor coordinate that omits shell offset.

Only execution nondeterminism was removed: there is no `setInterval`, Electron
IPC, `Math.random` sensor noise, or wall-clock timewarp. Each scheduled command
is applied for a fixed interval `[t, t + 0.1 s)`. A sample at a transition holds
the command used in the immediately preceding interval and the resulting state.

`characterization.fixtures.ts` captures 0%, 25%, 50%, and 100% open-loop traces
plus a heat/cooldown trace. The equality of the three positive-duty traces is a
real v1 numerical artifact: at even 25% duty, the tiny air-cell heat capacity
pushes heater cells into the 1,200 C cap on their first step. These fixtures are
a behavioral comparison target, not parameters to copy into a digital twin.

Closed-loop fixtures reproduce the dependency pinned by the old lockfile:
`node-pid-controller@1.0.1`, integrity
`sha512-36gdeRz2emhIsznLpXksJSqmR13NU3vR+rkRlfHWCGGlZu9fK+dcTPRpud0FiH6b2Nhwm0kbcVk7vXFlg8Sw1w==`.
Its exact tarball source establishes the controller arithmetic. V1 supplied
`dt = 100`, although the dependency documents `dt` in seconds, and used gains
P=0.7, I=0.00004, D=120 with output clamped to 0..255.

The simulator interval was registered before the PID interval in
`dummy-mcu/main.js`. The deterministic runner preserves that registration order:
each plant step consumes the previous controller output, then the controller
reads the new temperature and calculates output for the following step. Target
commands are restricted to exact step boundaries. This removes real event-loop
jitter without inventing an ordering the source did not establish.

The 100 C, 150 C, 200 C, and heat/cool fixtures disable sensor noise but retain
unbounded integral state. Consequently, `M104 S0` after the 200 C heat stage
still leaves v1 commanding full power for about another minute. This unsafe
windup is reference behavior only, not a mechanism for the new digital twin.
