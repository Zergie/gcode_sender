/** Stateful UTF-8 decoder for byte-oriented firmware TX chunks split by host steps. */
export class FirmwareSerialTextDecoder {
  private readonly decoder = new TextDecoder();

  decode(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  finish(): string {
    return this.decoder.decode();
  }
}
