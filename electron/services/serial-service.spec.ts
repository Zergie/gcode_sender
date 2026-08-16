import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../logger';
import { ActivityService } from './activity-service';

const LEGACY_M115_RESPONSE =
  'FIRMWARE_NAME: Arduino Gcode Interpreter v0.3 SOURCE_CODE_URL: https://github.com/Zergie PROTOCOL_VERSION: 1.0 MACHINE_TYPE: DIY Toaster UUID: 554d5e22-d685-4c68-973a-b57ff1e82f6f';

const serialPortMock = vi.hoisted(() => ({
  instances: [] as Array<{ readonly writes: string[] }>,
  list: vi.fn(),
}));

vi.mock('serialport', () => {
  type Listener = (...arguments_: unknown[]) => void;

  class MockSerialPort {
    static list = serialPortMock.list;
    readonly writes: string[] = [];
    private readonly listeners = new Map<string, Listener[]>();
    isOpen = false;

    constructor() {
      serialPortMock.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...arguments_: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...arguments_);
    }

    removeAllListeners(): void {
      this.listeners.clear();
    }

    open(callback: (error: Error | null) => void): void {
      this.isOpen = true;
      callback(null);
    }

    write(data: string, callback: (error: Error | null) => void): void {
      this.writes.push(data);
      callback(null);
      if (data === 'M115\n') {
        queueMicrotask(() => {
          const response = `${LEGACY_M115_RESPONSE}\n`;
          this.emit('data', Buffer.from(response.slice(0, 37), 'utf8'));
          this.emit('data', Buffer.from(response.slice(37, 121), 'utf8'));
          this.emit('data', Buffer.from(response.slice(121), 'utf8'));
        });
      }
    }

    drain(callback: (error: Error | null) => void): void {
      callback(null);
    }

    close(callback: (error: Error | null) => void): void {
      this.isOpen = false;
      callback(null);
      this.emit('close');
    }
  }

  return { SerialPort: MockSerialPort };
});

describe('SerialService firmware handshake', () => {
  beforeEach(() => {
    serialPortMock.instances.length = 0;
    serialPortMock.list.mockReset();
  });

  it('completes the M115 handshake with the exact response from the connected STM32', async () => {
    const { SerialService } = await import('./serial-service');
    const service = new SerialService(new ActivityService(), silentLogger());

    await expect(service.connect({ path: 'COM3', handshakeTimeoutMs: 250 })).resolves.toMatchObject(
      {
        status: 'connected',
        portPath: 'COM3',
        firmware: {
          firmwareName: 'Arduino Gcode Interpreter v0.3',
          protocolVersion: '1.0',
          machineType: 'DIY Toaster',
        },
      },
    );
    expect(serialPortMock.instances).toHaveLength(1);
    expect(serialPortMock.instances[0]?.writes).toEqual(['M115\n']);
  });
});

function silentLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
