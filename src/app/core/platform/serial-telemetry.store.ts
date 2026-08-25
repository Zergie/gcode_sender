import { Injectable, inject, signal } from '@angular/core';
import type { OnDestroy } from '@angular/core';
import type {
  FirmwareInfo,
  GcodeApi,
  SerialConnectionState,
  SerialLineEvent,
  SerialPortDescriptor,
  TemperatureTelemetry,
} from '../../../../shared/contracts';
import { NotificationStore } from './notification.store';

const DEFAULT_CONNECTION: SerialConnectionState = {
  status: 'disconnected',
  portPath: null,
  baudRate: 115200,
  firmware: null,
  connectedAt: null,
  error: null,
};

const DEFAULT_TELEMETRY: TemperatureTelemetry = {
  timestamp: new Date().toISOString(),
  average: 22,
  target: 0,
  power: 0,
  thermistors: [22, 22, 22],
  raw: '',
};

export interface SerialTelemetryEntry extends SerialLineEvent {
  readonly id: number;
}

/** Owns the renderer-facing serial boundary and all serial-derived presentation state. */
@Injectable({ providedIn: 'root' })
export class SerialTelemetryStore implements OnDestroy {
  private readonly notifications = inject(NotificationStore);
  private readonly api: GcodeApi | undefined =
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { readonly gcode?: GcodeApi }).gcode;
  private readonly unsubscribe: Array<() => void> = [];
  private initialized = false;
  private destroyed = false;
  private portsRefreshPromise: Promise<void> | null = null;
  private terminalId = 0;

  readonly connection = signal<SerialConnectionState>(DEFAULT_CONNECTION);
  readonly ports = signal<readonly SerialPortDescriptor[]>([]);
  readonly selectedPort = signal('');
  readonly serialPortDialogOpen = signal(false);
  readonly serialPortsRefreshing = signal(false);
  readonly telemetry = signal<TemperatureTelemetry>(DEFAULT_TELEMETRY);
  readonly hasTelemetry = signal(false);
  readonly terminal = signal<readonly SerialTelemetryEntry[]>([]);
  readonly commandHistory = signal<readonly string[]>([]);

  get desktopApi(): GcodeApi | undefined {
    return this.api;
  }

  initialize(
    onConnectionState: (state: SerialConnectionState) => void,
    onTelemetry: (event: TemperatureTelemetry) => void,
    onFirmware: (firmware: FirmwareInfo) => void,
    onFirmwareError: (message: string) => void,
  ): void {
    if (this.initialized || this.api === undefined || this.destroyed) return;
    this.initialized = true;
    this.unsubscribe.push(
      this.api.events.onSerialState((state) => {
        this.connection.set(state);
        if (state.status !== 'connected') this.hasTelemetry.set(false);
        onConnectionState(state);
      }),
      this.api.events.onSerialLine((event) => this.appendTerminal(event)),
      this.api.events.onTelemetry((event) => {
        this.telemetry.set(event);
        this.hasTelemetry.set(true);
        onTelemetry(event);
      }),
      this.api.events.onFirmware((firmware) => {
        this.connection.update((state) => ({ ...state, firmware }));
        onFirmware(firmware);
      }),
      this.api.events.onFirmwareError((event) => onFirmwareError(event.message)),
    );
  }

  async loadState(): Promise<void> {
    if (this.api === undefined) return;
    const result = await this.api.serial.getState();
    if (result.ok) this.connection.set(result.value);
  }

  refreshPorts(): Promise<void> {
    if (this.portsRefreshPromise !== null) return this.portsRefreshPromise;
    this.serialPortsRefreshing.set(true);
    const refresh = this.loadPorts().finally(() => {
      if (this.portsRefreshPromise === refresh) {
        this.portsRefreshPromise = null;
        this.serialPortsRefreshing.set(false);
      }
    });
    this.portsRefreshPromise = refresh;
    return refresh;
  }

  async connect(path: string, startupMacro: string): Promise<SerialConnectionState | null> {
    if (this.api === undefined) return null;
    const result = await this.api.serial.connect({ path, startupMacro });
    if (result.ok) this.connection.set(result.value);
    else this.connection.update((state) => ({ ...state, status: 'error', error: result.error }));
    return result.ok ? result.value : null;
  }

  async disconnect(): Promise<SerialConnectionState | null> {
    if (this.api === undefined) return null;
    const result = await this.api.serial.disconnect();
    if (result.ok) this.connection.set(result.value);
    else this.notifications.show(result.error.message);
    return result.ok ? result.value : null;
  }

  async send(command: string, origin: 'terminal' | 'tuning' | 'control'): Promise<boolean> {
    if (this.api === undefined) return true;
    const result = await this.api.serial.send({ command, origin });
    if (!result.ok) this.notifications.show(result.error.message);
    return result.ok;
  }

  selectPort(path: string): void {
    this.selectedPort.set(path);
  }

  recordCommand(command: string): void {
    this.commandHistory.update((items) =>
      [command, ...items.filter((item) => item !== command)].slice(0, 50),
    );
  }

  recordTerminal(event: SerialLineEvent): void {
    this.appendTerminal(event);
  }

  resetTelemetry(): void {
    this.hasTelemetry.set(false);
  }

  clearSelectionIfUnavailable(): void {
    const selected = this.selectedPort();
    if (selected !== '' && !this.ports().some((port) => port.path === selected)) {
      this.selectedPort.set('');
    }
  }

  ngOnDestroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
  }

  private async loadPorts(): Promise<void> {
    try {
      if (this.api === undefined) {
        this.ports.set([
          {
            path: 'COM4',
            friendlyName: 'STM32 Virtual COM Port',
            manufacturer: 'STMicroelectronics',
          },
          { path: 'COM7', friendlyName: 'USB Serial Device' },
        ]);
        this.clearSelectionIfUnavailable();
        return;
      }
      const result = await this.api.serial.listPorts();
      if (result.ok) this.ports.set(result.value);
      else {
        this.ports.set([]);
        this.notifications.show(result.error.message);
      }
      this.clearSelectionIfUnavailable();
    } catch (error) {
      this.ports.set([]);
      this.clearSelectionIfUnavailable();
      this.notifications.show(
        error instanceof Error ? error.message : 'Unable to enumerate serial ports.',
      );
    }
  }

  private appendTerminal(event: SerialLineEvent): void {
    this.terminal.update((entries) =>
      [...entries, { ...event, id: ++this.terminalId }].slice(-500),
    );
  }
}
