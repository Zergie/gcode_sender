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

## Bundled GCodeParser

Firmware-in-the-loop builds include GCodeParser 1.3.0.

- Project: GCodeParser
- Upstream source: https://github.com/tgolla/GCodeParser
- Copyright: Copyright (c) 2021 Terence Golla
- License: MIT; the complete text is included at
  `firmware-wasm/vendor/GCodeParser/LICENSE`.

## Bundled NTC_Thermistor

Firmware-in-the-loop builds include NTC_Thermistor 2.1.0.

- Project: NTC_Thermistor
- Upstream source: https://github.com/bobwolff68/NTC_Thermistor
- Copyright: Copyright (c) 2018-2019 Yurii Salimov
- License: MIT; the complete text is included at
  `firmware-wasm/vendor/NTC_Thermistor/LICENSE`.

## QuickPID controller semantics and bundled source

The host-side state estimator used for model-assisted forecasting is
line-derived from QuickPID 3.1.9 so its projected 100 ms cadence, gain scaling,
and conditional anti-windup match the supported STM32 firmware. It never owns
the simulated actuator loop. The same release's source is bundled for
firmware-in-the-loop builds.

- Project: QuickPID
- Upstream source: https://github.com/Dlloydev/QuickPID
- Copyright: Copyright 2023 David Lloyd <dlloydev@testcor.ca>
- License: MIT
- Bundled license: `firmware-wasm/vendor/QuickPID/LICENSE`

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## node-pid-controller v1 reference semantics

The isolated v1 characterization harness reproduces the arithmetic of the
dependency used by the original dummy MCU so its historic closed-loop output
can be compared deterministically.

- Package: node-pid-controller 1.0.1
- Upstream source: https://github.com/Philmod/node-pid-controller
- Author: Philmod <philippe.modard@gmail.com>
- Integrity:
  `sha512-36gdeRz2emhIsznLpXksJSqmR13NU3vR+rkRlfHWCGGlZu9fK+dcTPRpud0FiH6b2Nhwm0kbcVk7vXFlg8Sw1w==`
- License declared by the published package: BSD (variant not specified)

The published 1.0.1 tarball contains no license file, copyright statement, or
source-file license header from which a more specific BSD variant or notice
could be reproduced. This attribution therefore records the package's exact
available declaration without inventing missing license terms.
