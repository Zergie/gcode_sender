# Third-party notices

## Klipper PID calibration method

The live heater calibration workflow and final PID calculation in this project
are derived from Klipper's klippy/extras/pid_calibrate.py.

- Project: Klipper
- Upstream source:
  https://github.com/Klipper3d/klipper/blob/master/klippy/extras/pid_calibrate.py
- Copyright: Copyright (C) 2016-2018 Kevin O'Connor
- License: GNU General Public License version 3

The implementation is adapted for the supported STM32 firmware, which exposes
target commands and reported PID output but no direct host PWM command. This
project alternates bounded targets to emulate the relay cycle, retains draft
results, and uses the firmware as the safety authority.

The complete source of this application, including the adapted implementation,
is distributed under GPL-3.0-or-later. See [LICENSE](LICENSE).
