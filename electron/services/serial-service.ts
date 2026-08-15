import { SerialPort } from 'serialport';

import type {
  FirmwareErrorEvent,
  FirmwareInfo,
  SerialConnectRequest,
  SerialConnectionState,
  SerialLineEvent,
  SerialPortDescriptor,
  SerialSendOrigin,
  TemperatureTelemetry,
} from '../../shared/contracts';
import { AppError, asAppError } from '../../shared/errors';
import { normalizeStartupMacro } from '../../shared/job-normalizer';
import {
  isCompletionForCommand,
  parseFirmwareLine,
  type ParsedFirmwareLine,
} from '../../shared/protocol';
import type { Logger } from '../logger';
import type { ActivityService } from './activity-service';

type SerialEventMap = {
  readonly state: SerialConnectionState;
  readonly line: SerialLineEvent;
  readonly telemetry: TemperatureTelemetry;
  readonly firmware: FirmwareInfo;
  readonly firmwareError: FirmwareErrorEvent;
  readonly parsed: { readonly parsed: ParsedFirmwareLine; readonly raw: string };
};

type SerialEventName = keyof SerialEventMap;
type SerialListener<K extends SerialEventName> = (payload: SerialEventMap[K]) => void;

interface ResponseWaiter {
  readonly id: number;
  readonly predicate: (parsed: ParsedFirmwareLine) => boolean;
  readonly resolve: (response: {
    readonly parsed: ParsedFirmwareLine;
    readonly raw: string;
  }) => void;
  readonly reject: (error: AppError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abortCleanup: () => void;
}

export class SerialService {
  static readonly BAUD_RATE = 115200 as const;

  private port: SerialPort | null = null;
  private receiveBuffer = '';
  private lastRequest: SerialConnectRequest | null = null;
  private intentionalClose = false;
  private connectionGeneration = 0;
  private nextWaiterId = 1;
  private readonly waiters = new Map<number, ResponseWaiter>();
  private readonly listeners: { [K in SerialEventName]: Set<SerialListener<K>> } = {
    state: new Set(),
    line: new Set(),
    telemetry: new Set(),
    firmware: new Set(),
    firmwareError: new Set(),
    parsed: new Set(),
  };
  private state: SerialConnectionState = {
    status: 'disconnected',
    portPath: null,
    baudRate: SerialService.BAUD_RATE,
    firmware: null,
    connectedAt: null,
    error: null,
  };

  constructor(
    private readonly activity: ActivityService,
    private readonly logger: Logger,
  ) {}

  async listPorts(): Promise<readonly SerialPortDescriptor[]> {
    try {
      const ports = await SerialPort.list();
      return ports
        .map((port) => ({
          path: port.path,
          ...optionalString('manufacturer', port.manufacturer),
          ...optionalString('serialNumber', port.serialNumber),
          ...optionalString('productId', port.productId),
          ...optionalString('vendorId', port.vendorId),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
    } catch (error) {
      throw new AppError(
        {
          code: 'SERIAL_CONNECTION_FAILED',
          message: 'Unable to enumerate serial ports',
          recoverable: true,
        },
        { cause: error },
      );
    }
  }

  getState(): SerialConnectionState {
    return structuredClone(this.state);
  }

  async connect(request: SerialConnectRequest): Promise<SerialConnectionState> {
    validateConnectRequest(request);
    if (this.port !== null || !['disconnected', 'error'].includes(this.state.status)) {
      throw new AppError({
        code: 'INVALID_STATE',
        message: 'A serial connection is already active',
        recoverable: true,
      });
    }

    const attempt = ++this.connectionGeneration;
    this.lastRequest = { ...request };
    this.intentionalClose = false;
    this.updateState({
      status: 'connecting',
      portPath: request.path,
      firmware: null,
      connectedAt: null,
      error: null,
    });

    const port = new SerialPort({
      path: request.path,
      baudRate: SerialService.BAUD_RATE,
      autoOpen: false,
    });
    this.port = port;
    port.on('data', this.handleData);
    port.on('error', this.handlePortError);
    port.on('close', this.handlePortClose);

    try {
      await openPort(port);
      if (attempt !== this.connectionGeneration || this.port !== port) {
        await closeDetachedPort(port).catch(() => undefined);
        return this.getState();
      }
      this.updateState({ status: 'handshaking' });
      const handshakeTimeoutMs = request.handshakeTimeoutMs ?? 3_000;
      const response = this.waitForResponse(
        (parsed) => parsed.kind === 'firmware',
        handshakeTimeoutMs,
        undefined,
        'Firmware did not answer M115',
      );
      await this.writeLine('M115', 'system', true);
      const { parsed } = await response;
      if (attempt !== this.connectionGeneration || this.port !== port) {
        await closeDetachedPort(port).catch(() => undefined);
        return this.getState();
      }
      if (parsed.kind !== 'firmware') {
        throw new AppError({
          code: 'SERIAL_HANDSHAKE_FAILED',
          message: 'Invalid M115 response',
          recoverable: true,
        });
      }

      this.updateState({
        status: 'connected',
        firmware: parsed.value,
        connectedAt: new Date().toISOString(),
        error: null,
      });
      this.logger.info('Serial connection established', {
        portPath: request.path,
        firmware: parsed.value.firmwareName,
      });

      const startupCommands = normalizeStartupMacro(request.startupMacro ?? '');
      for (const command of startupCommands) {
        if (attempt !== this.connectionGeneration || this.port !== port) {
          await closeDetachedPort(port).catch(() => undefined);
          return this.getState();
        }
        await this.sendAndWait(command, 8_000, undefined, 'system');
      }
      return this.getState();
    } catch (error) {
      if (attempt !== this.connectionGeneration || this.port !== port) {
        await closeDetachedPort(port).catch(() => undefined);
        return this.getState();
      }
      const appError = asAppError(error, 'SERIAL_CONNECTION_FAILED');
      await this.closeCurrentPort().catch(() => undefined);
      this.updateState({
        status: 'error',
        firmware: null,
        connectedAt: null,
        error: appError.toInfo(),
      });
      throw appError;
    }
  }

  async disconnect(): Promise<SerialConnectionState> {
    this.connectionGeneration += 1;
    if (this.port === null) {
      this.updateState({
        status: 'disconnected',
        portPath: null,
        firmware: null,
        connectedAt: null,
        error: null,
      });
      return this.getState();
    }
    this.intentionalClose = true;
    this.updateState({ status: 'disconnecting' });
    await this.closeCurrentPort();
    this.updateState({
      status: 'disconnected',
      portPath: null,
      firmware: null,
      connectedAt: null,
      error: null,
    });
    this.logger.info('Serial connection closed by operator');
    return this.getState();
  }

  async reconnect(): Promise<SerialConnectionState> {
    if (this.lastRequest === null) {
      throw new AppError({
        code: 'INVALID_STATE',
        message: 'No previous serial port is available',
        recoverable: true,
      });
    }
    if (this.port !== null) {
      await this.disconnect();
    }
    return this.connect(this.lastRequest);
  }

  async send(command: string, origin: SerialSendOrigin): Promise<void> {
    this.activity.assertSerialWriteAllowed(origin);
    const lines = splitTransmission(command);
    for (const line of lines) {
      await this.writeLine(line, origin);
    }
  }

  async requestHeaterOff(): Promise<void> {
    await this.sendAndWait('M104 S0', 8_000, undefined, 'system');
  }

  async sendAndWait(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
    origin: SerialSendOrigin | 'job' | 'system' = 'job',
  ): Promise<{ readonly parsed: ParsedFirmwareLine; readonly raw: string }> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
      throw new AppError({
        code: 'INVALID_ARGUMENT',
        message: 'Command timeout is invalid',
        recoverable: true,
      });
    }
    const normalized = requireSingleLine(command);
    const response = this.waitForResponse(
      (parsed) => isCompletionForCommand(normalized, parsed),
      timeoutMs,
      signal,
      `No completion response for ${normalized}`,
    );
    try {
      await this.writeLine(normalized, origin, origin === 'system');
    } catch (error) {
      this.rejectMatchingWaiter();
      await response.catch(() => undefined);
      throw error;
    }
    return response;
  }

  async bestEffortHeaterOff(): Promise<void> {
    try {
      await this.writeLine('M104 S0', 'system', true);
    } catch (error) {
      this.logger.warn('Best-effort heater-off command could not be sent', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  subscribe<K extends SerialEventName>(event: K, listener: SerialListener<K>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private readonly handleData = (chunk: Buffer): void => {
    this.receiveBuffer += chunk.toString('utf8');
    let newlineIndex = this.receiveBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.receiveBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      newlineIndex = this.receiveBuffer.indexOf('\n');
    }
    if (this.receiveBuffer.length > 1_000_000) {
      this.logger.warn('Discarding overlong unterminated serial input');
      this.receiveBuffer = '';
    }
  };

  private readonly handlePortError = (error: Error): void => {
    this.logger.error('Serial port error', { error: error.message, portPath: this.state.portPath });
    const appError = new AppError(
      { code: 'SERIAL_DISCONNECTED', message: error.message, recoverable: true },
      { cause: error },
    );
    this.updateState({ status: 'error', error: appError.toInfo() });
  };

  private readonly handlePortClose = (): void => {
    this.port = null;
    this.receiveBuffer = '';
    this.rejectAllWaiters(
      new AppError({
        code: 'SERIAL_DISCONNECTED',
        message: 'Serial port closed',
        recoverable: true,
      }),
    );
    if (!this.intentionalClose) {
      this.updateState({
        status: 'error',
        firmware: null,
        connectedAt: null,
        error: {
          code: 'SERIAL_DISCONNECTED',
          message: 'Serial connection closed unexpectedly',
          recoverable: true,
        },
      });
    }
  };

  private handleLine(line: string): void {
    const timestamp = new Date().toISOString();
    const parsed = parseFirmwareLine(line, timestamp);
    this.emit('line', { direction: 'rx', line, timestamp });
    this.emit('parsed', { parsed, raw: line });
    switch (parsed.kind) {
      case 'telemetry':
        this.emit('telemetry', parsed.value);
        break;
      case 'firmware':
        this.emit('firmware', parsed.value);
        break;
      case 'error':
        this.emit('firmwareError', { timestamp, message: parsed.message, raw: line });
        break;
      case 'message':
      case 'ok':
      case 'setting':
        break;
    }

    for (const [id, waiter] of this.waiters) {
      if (waiter.predicate(parsed)) {
        this.waiters.delete(id);
        clearTimeout(waiter.timer);
        waiter.abortCleanup();
        waiter.resolve({ parsed, raw: line });
      }
    }
  }

  private waitForResponse(
    predicate: (parsed: ParsedFirmwareLine) => boolean,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    timeoutMessage: string,
  ): Promise<{ readonly parsed: ParsedFirmwareLine; readonly raw: string }> {
    return new Promise((resolve, reject) => {
      const id = this.nextWaiterId++;
      const rejectWaiter = (error: AppError): void => {
        const waiter = this.waiters.get(id);
        if (waiter === undefined) {
          return;
        }
        this.waiters.delete(id);
        clearTimeout(waiter.timer);
        waiter.abortCleanup();
        reject(error);
      };
      const onAbort = (): void =>
        rejectWaiter(
          new AppError({ code: 'INVALID_STATE', message: 'Command cancelled', recoverable: true }),
        );
      const timer = setTimeout(
        () =>
          rejectWaiter(
            new AppError({ code: 'TIMEOUT', message: timeoutMessage, recoverable: true }),
          ),
        timeoutMs,
      );
      const abortCleanup = (): void => signal?.removeEventListener('abort', onAbort);
      this.waiters.set(id, { id, predicate, resolve, reject, timer, abortCleanup });
      if (signal?.aborted === true) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private rejectMatchingWaiter(): void {
    // write failures invalidate every in-flight request because response ordering
    // can no longer be established safely.
    this.rejectAllWaiters(
      new AppError({
        code: 'SERIAL_WRITE_FAILED',
        message: 'Serial write failed',
        recoverable: true,
      }),
    );
  }

  private rejectAllWaiters(error: AppError): void {
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      clearTimeout(waiter.timer);
      waiter.abortCleanup();
      waiter.reject(error);
    }
  }

  private async writeLine(
    command: string,
    origin: SerialSendOrigin | 'job' | 'system',
    allowDuringHandshake = false,
  ): Promise<void> {
    const line = requireSingleLine(command);
    const port = this.port;
    const allowedStatus =
      this.state.status === 'connected' ||
      (allowDuringHandshake && this.state.status === 'handshaking');
    if (port === null || !port.isOpen || !allowedStatus) {
      throw new AppError({
        code: 'NOT_CONNECTED',
        message: 'Serial port is not connected',
        recoverable: true,
      });
    }
    try {
      await writePort(port, `${line}\n`);
      this.emit('line', { direction: 'tx', line, timestamp: new Date().toISOString(), origin });
    } catch (error) {
      throw new AppError(
        {
          code: 'SERIAL_WRITE_FAILED',
          message: 'Unable to write to the serial port',
          recoverable: true,
        },
        { cause: error },
      );
    }
  }

  private async closeCurrentPort(): Promise<void> {
    const port = this.port;
    if (port === null) {
      return;
    }
    this.rejectAllWaiters(
      new AppError({
        code: 'SERIAL_DISCONNECTED',
        message: 'Serial connection closed',
        recoverable: true,
      }),
    );
    if (port.isOpen) {
      await closePort(port);
    } else {
      port.removeAllListeners();
      this.port = null;
    }
  }

  private updateState(patch: Partial<SerialConnectionState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }

  private emit<K extends SerialEventName>(event: K, payload: SerialEventMap[K]): void {
    for (const listener of this.listeners[event]) {
      (listener as SerialListener<K>)(payload);
    }
  }
}

function validateConnectRequest(request: SerialConnectRequest): void {
  if (typeof request !== 'object' || request === null || typeof request.path !== 'string') {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'A serial port path is required',
      recoverable: true,
    });
  }
  if (request.path.length < 1 || request.path.length > 1_024 || /[\r\n\0]/.test(request.path)) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'Serial port path is invalid',
      recoverable: true,
    });
  }
  if (
    request.startupMacro !== undefined &&
    (typeof request.startupMacro !== 'string' || request.startupMacro.length > 100_000)
  ) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'Startup macro is invalid',
      recoverable: true,
    });
  }
  if (
    request.handshakeTimeoutMs !== undefined &&
    (!Number.isInteger(request.handshakeTimeoutMs) ||
      request.handshakeTimeoutMs < 250 ||
      request.handshakeTimeoutMs > 60_000)
  ) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'Handshake timeout is invalid',
      recoverable: true,
    });
  }
}

function requireSingleLine(command: string): string {
  if (typeof command !== 'string') {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'Command must be text',
      recoverable: true,
    });
  }
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 16_384 || /[\r\n\0]/.test(trimmed)) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'Command must be one nonempty line',
      recoverable: true,
    });
  }
  return trimmed;
}

function splitTransmission(command: string): readonly string[] {
  if (typeof command !== 'string' || command.length > 100_000 || command.includes('\0')) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'Terminal transmission is invalid',
      recoverable: true,
    });
  }
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'Enter at least one command',
      recoverable: true,
    });
  }
  lines.forEach(requireSingleLine);
  return lines;
}

function optionalString<K extends keyof SerialPortDescriptor>(
  key: K,
  value: string | undefined,
): Partial<Pick<SerialPortDescriptor, K>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Pick<SerialPortDescriptor, K>>);
}

function openPort(port: SerialPort): Promise<void> {
  return new Promise((resolve, reject) =>
    port.open((error) => (error === null ? resolve() : reject(error))),
  );
}

async function closeDetachedPort(port: SerialPort): Promise<void> {
  port.removeAllListeners();
  if (port.isOpen) {
    await closePort(port);
  }
}

function closePort(port: SerialPort): Promise<void> {
  return new Promise((resolve, reject) =>
    port.close((error) => (error === null ? resolve() : reject(error))),
  );
}

function writePort(port: SerialPort, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    port.write(data, (writeError) => {
      if (writeError !== null) {
        reject(writeError);
        return;
      }
      port.drain((drainError) => (drainError === null ? resolve() : reject(drainError)));
    });
  });
}
