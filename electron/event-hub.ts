import type { WebContents } from 'electron';

import type { IpcChannel } from '../shared/ipc';
import type { Logger } from './logger';

export class EventHub {
  private target: WebContents | null = null;

  constructor(private readonly logger: Logger) {}

  attach(target: WebContents): void {
    this.target = target;
  }

  detach(target: WebContents): void {
    if (this.target === target) {
      this.target = null;
    }
  }

  emit<T>(channel: IpcChannel, payload: T): void {
    if (this.target === null || this.target.isDestroyed()) {
      return;
    }
    try {
      this.target.send(channel, payload);
    } catch (error) {
      this.logger.warn('Failed to emit renderer event', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
