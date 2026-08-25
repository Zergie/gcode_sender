// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationStore } from './notification.store';

describe('NotificationStore', () => {
  let store: NotificationStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new NotificationStore();
  });

  afterEach(() => {
    store.ngOnDestroy();
    vi.useRealTimers();
  });

  it('replaces notifications and dismisses only the current one after four seconds', () => {
    store.show('first');
    vi.advanceTimersByTime(3_999);
    store.show('second');

    vi.advanceTimersByTime(1);
    expect(store.toast()).toBe('second');
    vi.advanceTimersByTime(3_999);
    expect(store.toast()).toBeNull();
  });

  it('does not let an earlier timer dismiss a repeated message', () => {
    store.show('same');
    vi.advanceTimersByTime(2_000);
    store.show('same');

    vi.advanceTimersByTime(2_000);
    expect(store.toast()).toBe('same');
    vi.advanceTimersByTime(2_000);
    expect(store.toast()).toBeNull();
  });

  it('supports explicit dismissal and clears timers during destruction', () => {
    store.show('message');
    store.dismiss();
    expect(store.toast()).toBeNull();
    vi.advanceTimersByTime(4_000);
    expect(store.toast()).toBeNull();

    store.show('another');
    store.ngOnDestroy();
    vi.advanceTimersByTime(4_000);
    expect(store.toast()).toBeNull();
  });
});
