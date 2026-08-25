import { describe, expect, it } from 'vitest';

import type { AppError } from '../../shared/errors';
import { readGcodeLines } from './gcode-line-reader';

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

async function collect(
  source: AsyncIterable<Uint8Array>,
  maxBytes = 64,
): Promise<readonly string[]> {
  const lines: string[] = [];
  for await (const line of readGcodeLines(source, { fileName: 'test.gcode', maxBytes })) {
    lines.push(line.text);
  }
  return lines;
}

describe('bounded UTF-8 G-code line reader', () => {
  it('handles line endings and UTF-8 code points split across chunks', async () => {
    await expect(collect(chunks('G1 X1\r', '\nG1 ', ' café\nlast'))).resolves.toEqual([
      'G1 X1',
      'G1  café',
      'last',
    ]);
  });

  it('accepts an exact limit and rejects the next byte without retaining the rest', async () => {
    await expect(collect(chunks('12345\n'), 5)).resolves.toEqual(['12345']);
    await expect(collect(chunks('123456', ' enormous tail'), 5)).rejects.toMatchObject({
      code: 'FILE_LINE_TOO_LONG',
      details: { fileName: 'test.gcode', sourceLine: 1, maxBytes: 5 },
    } satisfies Partial<AppError>);
  });

  it('reports invalid UTF-8 as a recoverable file error', async () => {
    async function* invalid(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from([0x47, 0x31, 0xff, 0x0a]);
    }
    await expect(collect(invalid())).rejects.toMatchObject({
      code: 'FILE_INVALID',
      details: { sourceLine: 1, reason: 'invalid-utf8' },
    });
  });
});
