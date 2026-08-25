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

  it.each([
    ['', ['M115\n']],
    ['M104 S180', ['M115\n', 'M104 S180\n']],
    ['M104 S180\nM104 S181\nM104 S182', ['M115\n', 'M104 S180\n', 'M104 S181\n', 'M104 S182\n']],
  ])(
    'publishes connected only after the %s startup macro completes',
    async (startupMacro, expectedWrites) => {
      const { SerialService } = await import('./serial-service');
      const service = new SerialService(new ActivityService(), silentLogger());
      const states: string[] = [];
      service.subscribe('state', (state) => states.push(state.status));

      const connection = service.connect({ path: 'COM3', startupMacro, handshakeTimeoutMs: 250 });
      await eventually(() => expect(serialPortMock.instances).toHaveLength(1));
      const port = serialPortMock.instances[0]!;
      port.releaseOpen();
      await eventually(() => expect(port.writes).toEqual(['M115\n']));
      port.releaseWrite();
      port.releaseDrain();
      port.injectData(`${LEGACY_M115_RESPONSE}\n`);

      for (let index = 1; index < expectedWrites.length; index += 1) {
        await eventually(() => expect(port.writes).toEqual(expectedWrites.slice(0, index + 1)));
        expect(states).toEqual(['connecting', 'handshaking']);
        expect(service.getState().status).toBe('handshaking');
        port.releaseWrite();
        port.releaseDrain();
        port.injectData('ok\n');
      }

      await expect(connection).resolves.toMatchObject({ status: 'connected' });
      expect(states).toEqual(['connecting', 'handshaking', 'connected']);
      expect(port.writes).toEqual(expectedWrites);
    },
  );

  it('rejects terminal traffic while a startup acknowledgement is deferred', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const connection = service.connect({
      path: 'COM3',
      startupMacro: 'M104 S180',
      handshakeTimeoutMs: 250,
    });
    await eventually(() => expect(serialPortMock.instances).toHaveLength(1));
    const port = serialPortMock.instances[0]!;
    port.releaseOpen();
    await eventually(() => expect(port.writes).toEqual(['M115\n']));
    port.releaseWrite();
    port.releaseDrain();
    port.injectData(`${LEGACY_M115_RESPONSE}\n`);
    await eventually(() => expect(port.writes).toEqual(['M115\n', 'M104 S180\n']));

    await expect(service.send('G1 X1', 'terminal')).rejects.toMatchObject({
      code: 'NOT_CONNECTED',
    });
    expect(port.writes).toEqual(['M115\n', 'M104 S180\n']);

    port.releaseWrite();
    port.releaseDrain();
    port.injectData('ok\n');
    await expect(connection).resolves.toMatchObject({ status: 'connected' });
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

  it('retires an errored connected port promptly and allows reconnection', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const firstPort = await connectService(service);
    const pending = service.sendAndWait('M104 S200', 1_000);
    const pendingOutcome = pending.then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await eventually(() => expect(firstPort.writes).toContain('M104 S200\n'));
    firstPort.releaseWrite();
    firstPort.releaseDrain();

    firstPort.injectError(new Error('USB link lost'));

    await expect(pendingOutcome).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'SERIAL_DISCONNECTED' },
    });
    expect(service.getState()).toMatchObject({
      status: 'error',
      error: { code: 'SERIAL_DISCONNECTED', message: 'USB link lost' },
    });
    expect(firstPort.writes).not.toContain('M104 S0\n');

    const reconnect = service.connect({ path: 'COM4', handshakeTimeoutMs: 250 });
    await eventually(() => expect(serialPortMock.instances).toHaveLength(2));
    const secondPort = serialPortMock.instances[1]!;
    await completeHandshake(secondPort);
    await expect(reconnect).resolves.toMatchObject({ status: 'connected', portPath: 'COM4' });
  });

  it.each([
    [
      'opening',
      async (port: InstanceType<typeof serialPortMock.ControlledSerialPort>) => {
        port.releaseOpen(new Error('open failed'));
      },
    ],
    [
      'handshake',
      async (port: InstanceType<typeof serialPortMock.ControlledSerialPort>) => {
        port.releaseOpen();
        await eventually(() => expect(port.writes).toEqual(['M115\n']));
        port.releaseWrite();
        port.releaseDrain();
        port.injectError(new Error('handshake link lost'));
      },
    ],
    [
      'startup',
      async (port: InstanceType<typeof serialPortMock.ControlledSerialPort>) => {
        port.releaseOpen();
        await eventually(() => expect(port.writes).toEqual(['M115\n']));
        port.releaseWrite();
        port.releaseDrain();
        port.injectData(`${LEGACY_M115_RESPONSE}\n`);
        await eventually(() => expect(port.writes).toEqual(['M115\n', 'M104 S180\n']));
        port.releaseWrite();
        port.releaseDrain();
        port.injectError(new Error('startup link lost'));
      },
    ],
  ])('retires a port when it errors during %s', async (_phase, failPort) => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const connection = service.connect({
      path: 'COM3',
      startupMacro: 'M104 S180',
      handshakeTimeoutMs: 250,
    });
    const connectionOutcome = connection.then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await eventually(() => expect(serialPortMock.instances).toHaveLength(1));
    await failPort(serialPortMock.instances[0]!);

    await expect(connectionOutcome).resolves.toMatchObject({
      status: 'rejected',
      error: {
        code: _phase === 'opening' ? 'SERIAL_CONNECTION_FAILED' : 'SERIAL_DISCONNECTED',
      },
    });
    expect(service.getState()).toMatchObject({ status: 'error' });
    expect(serialPortMock.instances[0]!.writes).not.toContain('M104 S0\n');
  });

  it('ignores late and repeated lifecycle events from a retired port', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const firstPort = await connectService(service);
    firstPort.injectError(new Error('first failure'));
    firstPort.injectError(new Error('stale failure'));
    firstPort.injectClose();

    const reconnect = service.connect({ path: 'COM4', handshakeTimeoutMs: 250 });
    await eventually(() => expect(serialPortMock.instances).toHaveLength(2));
    const secondPort = serialPortMock.instances[1]!;
    firstPort.injectData(`${LEGACY_M115_RESPONSE}\nok\n`);
    firstPort.injectError(new Error('late stale failure'));
    await completeHandshake(secondPort);

    await expect(reconnect).resolves.toMatchObject({ status: 'connected', portPath: 'COM4' });
    expect(service.getState().error).toBeNull();
  });

  it('ignores an error that arrives after an unexpected close', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const firstPort = await connectService(service);
    firstPort.injectClose();
    firstPort.injectError(new Error('late driver error'));

    expect(service.getState()).toMatchObject({
      status: 'error',
      error: { message: 'Serial connection closed unexpectedly' },
    });
    const reconnect = service.connect({ path: 'COM4', handshakeTimeoutMs: 250 });
    await eventually(() => expect(serialPortMock.instances).toHaveLength(2));
    await completeHandshake(serialPortMock.instances[1]!);
    await expect(reconnect).resolves.toMatchObject({ status: 'connected' });
  });

  it('keeps the unexpected error state when retirement close fails', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());
    const port = await connectService(service);
    port.injectError(new Error('close failure path'));
    port.releaseClose(new Error('driver close failed'));

    expect(service.getState()).toMatchObject({
      status: 'error',
      error: { message: 'close failure path' },
    });
    const reconnect = service.connect({ path: 'COM4', handshakeTimeoutMs: 250 });
    await eventually(() => expect(serialPortMock.instances).toHaveLength(2));
    await completeHandshake(serialPortMock.instances[1]!);
    await expect(reconnect).resolves.toMatchObject({ status: 'connected' });
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

async function completeHandshake(
  port: InstanceType<typeof serialPortMock.ControlledSerialPort>,
): Promise<void> {
  port.releaseOpen();
  await eventually(() => expect(port.writes).toEqual(['M115\n']));
  port.releaseWrite();
  port.releaseDrain();
  port.injectData(`${LEGACY_M115_RESPONSE}\n`);
  await eventually(() => expect(port.writes).toEqual(['M115\n']));
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
