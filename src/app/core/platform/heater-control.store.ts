import { Injectable, inject, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import type { ControlMode } from '../../../../shared/contracts';
import { NotificationStore } from './notification.store';
import { SerialTelemetryStore } from './serial-telemetry.store';
import {
  createPidSchedule,
  interpolatePidGains,
  type ModelAssistedTargetConfiguration,
  type PidGains,
  type PidSchedule,
} from '../control';
import { DEFAULT_SIMULATION_CONTROLLER, STANDARD_LOAD_PID_SCHEDULE } from '../simulation';

/** Owns operator heater intent and the single cadence that advances control. */
@Injectable({ providedIn: 'root' })
export class HeaterControlStore implements OnDestroy {
  private readonly notifications = inject(NotificationStore);
  private readonly serial = inject(SerialTelemetryStore);
  private controlTimer: ReturnType<typeof setInterval> | undefined;
  private destroyed = false;
  private controlGeneration = 0;
  private lastGainsSent: PidGains | null = null;
  private lastFirmwareTargetSent: number | null = null;

  readonly requestedTarget = signal(0);
  readonly modelTarget = signal(0);
  readonly controlMode = signal<ControlMode>('pid');
  readonly controlArmed = signal(false);
  readonly pidSchedule = signal<PidSchedule>(STANDARD_LOAD_PID_SCHEDULE);
  readonly activePidGains = signal<PidGains>(interpolatePidGains(STANDARD_LOAD_PID_SCHEDULE, 0));
  readonly modelAssistance = signal<ModelAssistedTargetConfiguration>({
    ...DEFAULT_SIMULATION_CONTROLLER.modelAssistance,
  });

  initialize(schedule: PidSchedule, onTick: () => void): void {
    this.pidSchedule.set(createPidSchedule(schedule));
    this.activePidGains.set(interpolatePidGains(this.pidSchedule(), this.requestedTarget()));
    if (
      this.controlTimer === undefined &&
      !this.destroyed &&
      this.serial.desktopApi !== undefined
    ) {
      this.controlTimer = setInterval(onTick, 1_000);
    }
  }

  setMode(mode: ControlMode, firmwareAvailable: boolean): boolean {
    if (mode === 'model-assisted' && !firmwareAvailable) {
      this.notifications.show(
        'Select and compile a FIRMWARE .ino file in Settings before enabling Model-assisted PID.',
      );
      return false;
    }
    this.controlMode.set(mode);
    this.modelTarget.set(mode === 'pid' ? this.requestedTarget() : this.modelTarget());
    this.notifications.show(
      mode === 'pid' ? 'PID control selected' : 'Model-assisted PID selected',
    );
    return true;
  }

  async applyTarget(
    value: number,
    connected: boolean,
    busy: boolean,
    advance: () => Promise<void>,
  ): Promise<void> {
    if (!Number.isFinite(value)) {
      this.notifications.show('Enter a finite target between 0 and 250 °C.');
      return;
    }
    if (connected && busy) {
      this.notifications.show(
        'Target changes are locked while an exclusive operation owns the controller.',
      );
      return;
    }
    this.requestedTarget.set(Math.min(250, Math.max(0, value)));
    if (!connected) {
      this.notifications.show(
        'Connect the controller, then apply the target again to arm desktop control.',
      );
      return;
    }
    this.controlArmed.set(true);
    this.controlGeneration += 1;
    await advance();
  }

  async stopHeating(connected: boolean, heaterOff: () => Promise<string | null>): Promise<void> {
    this.disarm();
    this.requestedTarget.set(0);
    this.modelTarget.set(0);
    this.lastFirmwareTargetSent = 0;
    if (connected) {
      const error = await heaterOff();
      if (error !== null) {
        this.notifications.show(`Heater-off was not confirmed: ${error}`);
        return;
      }
    }
    this.notifications.show('Heater-off confirmed with M104 S0.');
  }

  async applyPidSchedule(
    schedule: PidSchedule,
    connected: boolean,
    busy: boolean,
  ): Promise<boolean> {
    const validated = createPidSchedule(schedule);
    if (connected && busy) {
      this.notifications.show('The PID schedule cannot be changed during an exclusive operation.');
      return false;
    }
    this.pidSchedule.set(validated);
    const gains = interpolatePidGains(validated, this.requestedTarget());
    this.activePidGains.set(gains);
    this.lastGainsSent = null;
    if (!connected) return true;
    const result = await this.sendControl(this.pidCommand(gains));
    if (result) this.lastGainsSent = gains;
    return result;
  }

  setModelAssistance(assistance: ModelAssistedTargetConfiguration): void {
    this.modelAssistance.set({ ...assistance });
  }

  disarm(): void {
    this.controlArmed.set(false);
    this.controlGeneration += 1;
    this.lastFirmwareTargetSent = null;
    this.lastGainsSent = null;
  }

  get generation(): number {
    return this.controlGeneration;
  }
  get lastSentGains(): PidGains | null {
    return this.lastGainsSent;
  }
  get lastSentTarget(): number | null {
    return this.lastFirmwareTargetSent;
  }
  markGainsSent(gains: PidGains): void {
    this.lastGainsSent = gains;
  }
  markTargetSent(target: number): void {
    this.lastFirmwareTargetSent = target;
  }

  private pidCommand(gains: PidGains): string {
    return `M301 P${gains.kp.toFixed(3)} I${gains.ki.toFixed(3)} D${gains.kd.toFixed(3)}`;
  }

  private async sendControl(command: string): Promise<boolean> {
    if (this.serial.desktopApi === undefined) {
      this.serial.recordTerminal({
        direction: 'tx',
        line: command,
        timestamp: new Date().toISOString(),
        origin: 'control',
      });
      return true;
    }
    const result = await this.serial.send(command, 'control');
    if (!result) this.notifications.show('The control command was not accepted.');
    return result;
  }

  ngOnDestroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.controlTimer !== undefined) clearInterval(this.controlTimer);
    this.controlTimer = undefined;
  }
}
