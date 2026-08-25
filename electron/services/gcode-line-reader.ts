import { AppError } from '../../shared/errors';

export interface GcodeLine {
  readonly text: string;
  readonly sourceLine: number;
  readonly bytesRead: number;
}

export interface GcodeLineReaderContext {
  readonly fileName: string;
  readonly maxBytes: number;
}

/**
 * Reads physical G-code lines without allowing an unterminated line to grow
 * beyond the configured byte ceiling. Chunks are intentionally handled as
 * bytes so a UTF-8 code point split between chunks is decoded only after the
 * complete physical line is available.
 */
export async function* readGcodeLines(
  source: AsyncIterable<Uint8Array>,
  context: GcodeLineReaderContext,
): AsyncGenerator<GcodeLine> {
  if (!Number.isInteger(context.maxBytes) || context.maxBytes < 1) {
    throw new AppError({
      code: 'INVALID_ARGUMENT',
      message: 'The physical-line byte limit is invalid',
      recoverable: true,
    });
  }

  let lineBytes: number[] = [];
  let sourceLine = 0;
  let bytesRead = 0;

  try {
    for await (const chunk of source) {
      for (const byte of chunk) {
        bytesRead += 1;
        if (byte === 0x0a) {
          sourceLine += 1;
          yield {
            text: decodeLine(lineBytes, context.fileName, sourceLine, context.maxBytes),
            sourceLine,
            bytesRead,
          };
          lineBytes = [];
          continue;
        }
        if (byte === 0x0d) continue;
        lineBytes.push(byte);
        if (lineBytes.length > context.maxBytes) {
          throw lineTooLong(context, sourceLine + 1);
        }
      }
    }
    if (lineBytes.length > 0) {
      sourceLine += 1;
      yield {
        text: decodeLine(lineBytes, context.fileName, sourceLine, context.maxBytes),
        sourceLine,
        bytesRead,
      };
    }
  } finally {
    const closable = source as AsyncIterable<Uint8Array> & {
      destroy?: (error?: Error) => void;
    };
    closable.destroy?.();
  }
}

function decodeLine(
  bytes: readonly number[],
  fileName: string,
  sourceLine: number,
  maxBytes: number,
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch (error) {
    throw new AppError(
      {
        code: 'FILE_INVALID',
        message: `File '${fileName}' is not valid UTF-8 near line ${sourceLine}`,
        recoverable: true,
        details: { fileName, sourceLine, maxBytes, reason: 'invalid-utf8' },
      },
      { cause: error },
    );
  }
}

function lineTooLong(context: GcodeLineReaderContext, sourceLine: number): AppError {
  return new AppError({
    code: 'FILE_LINE_TOO_LONG',
    message: `File '${context.fileName}' exceeds the ${context.maxBytes}-byte physical-line limit at line ${sourceLine}`,
    recoverable: true,
    details: {
      fileName: context.fileName,
      sourceLine,
      maxBytes: context.maxBytes,
    },
  });
}
