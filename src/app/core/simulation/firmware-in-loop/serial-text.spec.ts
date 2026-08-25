import { describe, expect, it } from 'vitest';

import { FirmwareSerialTextDecoder } from './serial-text';

describe('firmware serial text decoder', () => {
  it('preserves a UTF-8 code point split across firmware steps', () => {
    const decoder = new FirmwareSerialTextDecoder();
    const bytes = new TextEncoder().encode('ready °C');

    expect(decoder.decode(bytes.slice(0, 6))).toBe('ready ');
    expect(decoder.decode(bytes.slice(6, 7))).toBe('');
    expect(decoder.decode(bytes.slice(7))).toBe('°C');
    expect(decoder.finish()).toBe('');
  });

  it('flushes a malformed trailing sequence explicitly', () => {
    const decoder = new FirmwareSerialTextDecoder();

    expect(decoder.decode(new Uint8Array([0xc2]))).toBe('');
    expect(decoder.finish()).toBe('\uFFFD');
  });
});
