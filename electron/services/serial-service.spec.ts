import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../logger';
import { ActivityService } from './activity-service';
import type { SerialService } from './serial-service';

const LEGACY_M115_RESPONSE =
  'FIRMWARE_NAME: Arduino Gcode Interpreter v0.3 SOURCE_CODE_URL: https://github.com/Zergie PROTOCOL_VERSION: 1.0 MACHINE_TYPE: DIY Toaster UUID: 554d5e22-d685-4c68-973a-b57ff1e82f6f';

const serialPortMock = vi.hoisted(() => {
  type Callback = (error: Error | null) => void;
  type Listener = (...arguments_: unknown[]) => void;

  class ControlledSerialPort {
    static list = vi.fn();
    readonly writes: string[] = [];
    private readonly listeners = new Map<string, Listener[]>();
    private openCallback: Callback | null = null;
    private readonly writeCallbacks: Callback[] = [];
    private readonly drainCallbacks: Callback[] = [];
    private closeCallback: Callback | null = null;
    isOpen = false;

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...arguments_: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...arguments_);
    }

    open(callback: Callback): void {
      this.openCallback = callback;
    }
    write(data: string, callback: Callback): void {
      this.writes.push(data);
      this.writeCallbacks.push(callback);
    }
    drain(callback: Callback): void {
      this.drainCallbacks.push(callback);
    }
    close(callback: Callback): void {
      this.closeCallback = callback;
    }

    releaseOpen(error: Error | null = null): void {
      if (error === null) this.isOpen = true;
      this.openCallback?.(error);
      this.openCallback = null;
    }
    releaseWrite(error: Error | null = null): void {
      this.writeCallbacks.shift()?.(error);
    }
    releaseDrain(error: Error | null = null): void {
      this.drainCallbacks.shift()?.(error);
    }
    releaseClose(error: Error | null = null): void {
      if (error === null) this.isOpen = false;
      this.closeCallback?.(error);
      this.closeCallback = null;
      if (error === null) this.emit('close');
    }
    injectData(data: string): void {
      this.emit('data', Buffer.from(data, 'utf8'));
    }
    injectError(error = new Error('controlled serial error')): void {
      this.emit('error', error);
    }
    injectClose(): void {
      this.isOpen = false;
      this.emit('close');
    }
    removeAllListeners(): void {
      this.listeners.clear();
    }
  }

  const instances: ControlledSerialPort[] = [];
  return { ControlledSerialPort, instances, list: ControlledSerialPort.list };
});

vi.mock('serialport', () => {
  class MockSerialPort extends serialPortMock.ControlledSerialPort {
    constructor() {
      super();
      serialPortMock.instances.push(this);
    }
  }
  return { SerialPort: MockSerialPort };
});

describe('SerialService firmware handshake', () => {
  beforeEach(() => {
    serialPortMock.instances.length = 0;
    serialPortMock.list.mockReset();
  });

  it('completes a controlled fragmented M115 handshake in public state order', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const states: string[] = [];
    service.subscribe('state', (state) => states.push(state.status));

    const connection = service.connect({ path: 'COM3', handshakeTimeoutMs: 250 });
    await eventually(() => expect(serialPortMock.instances).toHaveLength(1));
    const port = serialPortMock.instances[0]!;
    expect(states).toEqual(['connecting']);
    expect(port.writes).toEqual([]);

    port.releaseOpen();
    await eventually(() => expect(states).toEqual(['connecting', 'handshaking']));
    await eventually(() => expect(port.writes).toEqual(['M115\n']));
    expect(states).toEqual(['connecting', 'handshaking']);

    port.releaseWrite();
    expect(port.writes).toEqual(['M115\n']);
    port.releaseDrain();
    expect(states).toEqual(['connecting', 'handshaking']);

    const response = `${LEGACY_M115_RESPONSE}\n`;
    port.injectData(response.slice(0, 37));
    port.injectData(response.slice(37, 121));
    port.injectData(response.slice(121));

    await expect(connection).resolves.toMatchObject({
      status: 'connected',
      portPath: 'COM3',
      firmware: {
        firmwareName: 'Arduino Gcode Interpreter v0.3',
        protocolVersion: '1.0',
        machineType: 'DIY Toaster',
      },
    });
    expect(states).toEqual(['connecting', 'handshaking', 'connected']);
    expect(port.writes).toEqual(['M115\n']);
  });

  it('assigns one compatible firmware response to only one command transaction', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const port = await connectService(service);

    const first = service.sendAndWait('M104 S200', 1_000);
    const second = service.sendAndWait('M104 S210', 1_000);
    await eventually(() => expect(port.writes).toEqual(['M115\n', 'M104 S200\n', 'M104 S210\n']));
    port.releaseWrite();
    port.releaseDrain();
    port.releaseWrite();
    port.releaseDrain();

    const telemetry: unknown[] = [];
    service.subscribe('telemetry', (value) => telemetry.push(value));
    port.injectData('T0:25 /200 @:0 T1:25 T2:25 T3:25\n');
    await expect(first).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(telemetry).toHaveLength(1);

    port.injectData('ok\n');
    await expect(second).resolves.toMatchObject({ parsed: { kind: 'ok' } });
  });

  it('removes timeout and abort waiters before later commands use the channel', async () => {
    vi.useFakeTimers();
    try {
      const { SerialService } = await import('./serial-service');
      const service = new SerialService(new ActivityService(), silentLogger());
      const port = await connectService(service);

      const timedOut = service.sendAndWait('M104 S200', 100);
      const timedOutResult = timedOut.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await flushCommandWrite(port);
      await vi.advanceTimersByTimeAsync(100);
      await expect(timedOutResult).resolves.toMatchObject({
        status: 'rejected',
        error: { code: 'TIMEOUT' },
      });

      const controller = new AbortController();
      const aborted = service.sendAndWait('M104 S210', 1_000, controller.signal);
      const abortedResult = aborted.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await flushCommandWrite(port);
      controller.abort();
      await expect(abortedResult).resolves.toMatchObject({
        status: 'rejected',
        error: { code: 'INVALID_STATE' },
      });

      const later = service.sendAndWait('M104 S220', 1_000);
      await flushCommandWrite(port);
      port.injectData('ok\n');
      await expect(later).resolves.toMatchObject({ parsed: { kind: 'ok' } });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(port.writes).toContain('M104 S220\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a failed write and allows a subsequent transaction to complete', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const port = await connectService(service);

    const failed = service.sendAndWait('M104 S200', 1_000);
    await eventually(() => expect(port.writes).toContain('M104 S200\n'));
    port.releaseWrite(new Error('write failed'));
    await expect(failed).rejects.toMatchObject({ code: 'SERIAL_WRITE_FAILED' });

    const later = service.sendAndWait('M104 S220', 1_000);
    await flushCommandWrite(port);
    port.injectData('ok\n');
    await expect(later).resolves.toMatchObject({ parsed: { kind: 'ok' } });
  });
});

async function connectService(
  service: SerialService,
): Promise<InstanceType<typeof serialPortMock.ControlledSerialPort>> {
  const connection = service.connect({ path: 'COM3', handshakeTimeoutMs: 250 });
  await eventually(() => expect(serialPortMock.instances).toHaveLength(1));
  const port = serialPortMock.instances[0]!;
  port.releaseOpen();
  await eventually(() => expect(port.writes).toEqual(['M115\n']));
  port.releaseWrite();
  port.releaseDrain();
  port.injectData(`${LEGACY_M115_RESPONSE}\n`);
  await expect(connection).resolves.toMatchObject({ status: 'connected' });
  return port;
}

async function flushCommandWrite(
  port: InstanceType<typeof serialPortMock.ControlledSerialPort>,
): Promise<void> {
  await eventually(() => expect(port.writes.length).toBeGreaterThan(1));
  port.releaseWrite();
  port.releaseDrain();
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }
}

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
