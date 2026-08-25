import { Injectable, inject, signal } from '@angular/core';
import type { OnDestroy, Signal } from '@angular/core';
import type {
  CommandCatalogSnapshot,
  GcodeApi,
  JsonValue,
  SessionKind,
  SessionMetadata,
} from '../../../../shared/contracts';
import { BUNDLED_COMMAND_CATALOG } from '../../../../shared/bundled-catalog';
import { ConfigurationStore } from '../configuration/configuration.store';
import { NotificationStore } from './notification.store';

const bundledCatalog: CommandCatalogSnapshot = {
  entries: BUNDLED_COMMAND_CATALOG,
  source: 'bundled',
  url: null,
  firmwareId: null,
  fetchedAt: null,
  stale: false,
};

/** Owns persisted activity history and the firmware command catalog. */
@Injectable({ providedIn: 'root' })
export class SessionCatalogStore implements OnDestroy {
  private readonly notifications = inject(NotificationStore);
  private readonly configuration = inject(ConfigurationStore);
  private readonly api: GcodeApi | undefined =
    typeof window === 'undefined' ? undefined : window.gcode;
  private readonly unsubscribe: Array<() => void> = [];
  private initialized = false;

  private readonly catalogState = signal<CommandCatalogSnapshot>(bundledCatalog);
  private readonly sessionsState = signal<readonly SessionMetadata[]>([]);

  readonly catalog: Signal<CommandCatalogSnapshot> = this.catalogState.asReadonly();
  readonly sessions: Signal<readonly SessionMetadata[]> = this.sessionsState.asReadonly();

  initialize(): void {
    if (this.initialized || this.api === undefined) return;
    this.initialized = true;
    this.unsubscribe.push(
      this.api.events.onCatalogSnapshot((snapshot) => this.catalogState.set(snapshot)),
    );
  }

  replaceCatalog(snapshot: CommandCatalogSnapshot): void {
    this.catalogState.set(snapshot);
  }

  replaceSessions(sessions: readonly SessionMetadata[]): void {
    this.sessionsState.set(sessions);
  }

  ngOnDestroy(): void {
    this.unsubscribe.splice(0).forEach((unsubscribe) => unsubscribe());
    this.initialized = false;
  }

  async refreshCatalog(): Promise<void> {
    if (this.api === undefined) {
      this.catalogState.update((current) => ({
        ...current,
        source: 'cache',
        fetchedAt: new Date().toISOString(),
        stale: false,
      }));
      this.notifications.show('Command catalog refreshed from demo cache.');
      return;
    }
    const result = await this.api.catalog.refresh();
    if (result.ok) this.catalogState.set(result.value);
    else this.notifications.show(result.error.message);
  }

  async revokeCatalogHost(host: string): Promise<void> {
    if (this.api === undefined) {
      this.notifications.show('Catalog host approval is unavailable in demo mode.');
      return;
    }
    const result = await this.api.catalog.revokeHost(host);
    if (result.ok) this.configuration.patchSettings({ approvedCatalogHosts: result.value });
    else this.notifications.show(result.error.message);
  }

  async refreshSessions(): Promise<void> {
    if (this.api === undefined) return;
    const result = await this.api.sessions.list();
    if (result.ok) this.sessionsState.set(result.value);
  }

  async saveSession(
    kind: SessionKind,
    title: string,
    data: unknown,
    startedAt = new Date().toISOString(),
  ): Promise<string | null> {
    const session: SessionMetadata = {
      id: crypto.randomUUID(),
      version: 1,
      kind,
      title,
      startedAt,
      endedAt: new Date().toISOString(),
      pinned: false,
      data: data as JsonValue,
    };
    if (this.api === undefined) {
      this.sessionsState.update((items) => [session, ...items].slice(0, 100));
      this.notifications.show(`${title} saved in the browser demo.`);
      return session.id;
    }
    const result = await this.api.sessions.save(session);
    if (!result.ok) {
      this.notifications.show(result.error.message);
      return null;
    }
    this.sessionsState.update((items) => [
      result.value,
      ...items.filter((item) => item.id !== result.value.id),
    ]);
    this.notifications.show(`${result.value.title} saved.`);
    return result.value.id;
  }

  async exportSessions(ids: readonly string[], format: 'json' | 'csv'): Promise<void> {
    if (this.api === undefined) {
      this.notifications.show('Session export opens a native save dialog in the desktop app.');
      return;
    }
    const result = await this.api.sessions.exportFile(ids, format);
    if (result.ok && result.value !== null)
      this.notifications.show(`Sessions exported to ${result.value}`);
    else if (!result.ok) this.notifications.show(result.error.message);
  }
}
