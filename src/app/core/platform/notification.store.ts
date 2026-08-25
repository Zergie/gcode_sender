import { Injectable, signal } from '@angular/core';
import type { OnDestroy, Signal } from '@angular/core';

const NOTIFICATION_DURATION_MS = 4_000;

/** Owns transient operator notifications independently from workflow state. */
@Injectable({ providedIn: 'root' })
export class NotificationStore implements OnDestroy {
  private readonly toastState = signal<string | null>(null);
  private dismissalTimer: ReturnType<typeof setTimeout> | undefined;
  private notificationGeneration = 0;

  readonly toast: Signal<string | null> = this.toastState.asReadonly();

  show(message: string): void {
    const generation = ++this.notificationGeneration;
    this.clearDismissalTimer();
    this.toastState.set(message);
    this.dismissalTimer = setTimeout(() => {
      if (generation === this.notificationGeneration) this.toastState.set(null);
      this.dismissalTimer = undefined;
    }, NOTIFICATION_DURATION_MS);
  }

  dismiss(): void {
    this.notificationGeneration += 1;
    this.clearDismissalTimer();
    this.toastState.set(null);
  }

  ngOnDestroy(): void {
    this.dismiss();
  }

  private clearDismissalTimer(): void {
    if (this.dismissalTimer !== undefined) {
      clearTimeout(this.dismissalTimer);
      this.dismissalTimer = undefined;
    }
  }
}
