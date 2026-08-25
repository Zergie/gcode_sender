import { AppError } from '../../shared/errors';
import type { ExclusiveActivity, ExclusiveActivityState } from '../../shared/contracts';

export class ActivityService {
  private active: ExclusiveActivity | null = null;
  private readonly listeners = new Set<(state: ExclusiveActivityState) => void>();

  getState(): ExclusiveActivityState {
    return { active: this.active };
  }

  acquire(activity: ExclusiveActivity): ExclusiveActivityState {
    if (this.active !== null) {
      throw new AppError({
        code: 'BUSY',
        message: `${this.active} currently owns the serial connection`,
        recoverable: true,
        details: { active: this.active, requested: activity },
      });
    }
    this.active = activity;
    return this.notify();
  }

  release(activity: ExclusiveActivity): ExclusiveActivityState {
    if (this.active === activity) {
      this.active = null;
      return this.notify();
    }
    return this.getState();
  }

  assertSerialWriteAllowed(origin: 'terminal' | 'control' | 'tuning'): void {
    if (this.active === null) {
      return;
    }
    if (this.active === 'tuning' && origin === 'tuning') {
      return;
    }
    if (this.active === 'validation' && origin === 'control') {
      return;
    }
    throw new AppError({
      code: 'BUSY',
      message: `Serial transmission is locked by ${this.active}`,
      recoverable: true,
      details: { active: this.active, origin },
    });
  }

  subscribe(listener: (state: ExclusiveActivityState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): ExclusiveActivityState {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
    return state;
  }
}
