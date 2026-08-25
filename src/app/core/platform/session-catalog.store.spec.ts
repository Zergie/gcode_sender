import { TestBed } from '@angular/core/testing';
import { SessionCatalogStore } from './session-catalog.store';
import { NotificationStore } from './notification.store';

describe('SessionCatalogStore', () => {
  let store: SessionCatalogStore;
  let notifications: NotificationStore;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [SessionCatalogStore, NotificationStore] });
    store = TestBed.inject(SessionCatalogStore);
    notifications = TestBed.inject(NotificationStore);
  });

  afterEach(() => {
    store.ngOnDestroy();
    notifications.ngOnDestroy();
  });

  it('keeps session history newest-first and retains the browser-demo contract', async () => {
    const first = await store.saveSession('terminal', 'First', { lineCount: 1 });
    const second = await store.saveSession('simulation', 'Second', { samples: 2 });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(store.sessions().map((session) => session.title)).toEqual(['Second', 'First']);
    expect(store.sessions().every((session) => session.version === 1)).toBe(true);
    expect(notifications.toast()).toBe('Second saved in the browser demo.');
  });

  it('refreshes the bundled catalog through the demo cache without replacing entries', async () => {
    const entries = store.catalog().entries;

    await store.refreshCatalog();

    expect(store.catalog()).toMatchObject({ source: 'cache', stale: false });
    expect(store.catalog().entries).toBe(entries);
    expect(notifications.toast()).toBe('Command catalog refreshed from demo cache.');
  });
});
