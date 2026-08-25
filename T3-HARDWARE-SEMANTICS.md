# T3 hardware semantics decision

**Decision date:** 2026-08-25  
**Decision scope:** the supported `pid_temp_with_gcode_stm32` oven hardware and
its desktop telemetry contract

## Decision

`T3` is the independent thermistor exposed at the enclosure boundary. It is an
informational enclosure-temperature measurement used by the desktop operator
experience and physical twin. `T3` remains the stable firmware telemetry
channel identity.

The canonical human-facing term is **T3 enclosure sensor**. Its concise
description is: **“Temperature measured by the externally exposed enclosure
thermistor; informational only.”**

The requested term **Safety sensor** is not approved. The repository's safety
boundary states that the desktop application is not a safety controller and
that the STM32 firmware and its watchdogs are the safety authority. No evidence
in the supported hardware or firmware contract establishes that T3 itself is
an authoritative implemented safety mechanism. Calling it a safety sensor
would therefore overstate its authority.

## Evidence and interpretation

- The supported-hardware contract describes three thermistors, with T0 as the
  T1/T2 average and T3 as the enclosure sensor.
- The architecture contract describes T3 as independently exposed and models
  its heat exchange with room air.
- The telemetry protocol identifies the channel as `T3:<temp>`; this decision
  does not rename or remap that protocol field.
- The application safety warning assigns safety authority to the STM32
  firmware and watchdogs, not to desktop telemetry or host-side alerts.

These sources establish placement and intended use, but do not certify T3 as
an interlock or other hardware safety function.

## Compatibility boundary

Existing telemetry, retained sessions, exports, and profiles keyed by `T3`
remain readable without migration or protocol remapping. Any persisted
human-facing label such as `enclosure/safety sensor` is a legacy label; new
output must use **T3 enclosure sensor** and the description above. Downstream
changes to rendered labels, model names, alerts, exports, and terminology
tests must use this decision as their authority.

Until those downstream changes are implemented, the existing product surfaces
remain unchanged. This record is the prerequisite decision, not a claim that
the current surfaces are already terminology-consistent.
