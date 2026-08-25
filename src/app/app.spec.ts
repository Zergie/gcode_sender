import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { WorkbenchStore } from './core/platform/workbench.store';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('keeps the header temperature unknown until a connected controller reports telemetry', () => {
    const fixture = TestBed.createComponent(App);
    const store = TestBed.inject(WorkbenchStore);
    fixture.detectChanges();

    const temperature = () =>
      fixture.nativeElement.querySelector('.top-temperature strong') as HTMLElement;
    expect(temperature().textContent?.trim()).toBe('—');
    expect(temperature().classList).toContain('unknown');

    store.connection.update((state) => ({ ...state, status: 'connected' }));
    fixture.detectChanges();
    expect(temperature().textContent?.trim()).toBe('—');

    store.telemetry.update((telemetry) => ({ ...telemetry, average: 68.4 }));
    store.hasTelemetry.set(true);
    fixture.detectChanges();
    expect(temperature().textContent?.trim()).toBe('68.4°');
    expect(temperature().classList).not.toContain('unknown');
  });

  it('renders the required navigation order', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const labels = [...compiled.querySelectorAll('.nav-item .nav-label')].map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toEqual(['Dashboard', 'Terminal', 'Jobs', 'Simulation', 'Settings', 'About']);
  });

  it('can expand the sidebar again after it was collapsed', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.collapsed.set(true);
    document.documentElement.dataset['sidebar'] = 'collapsed';

    app.collapseSidebar();

    expect(app.collapsed()).toBe(false);
    expect(document.documentElement.dataset['sidebar']).toBe('expanded');
    fixture.destroy();
  });

  it('opens a serial-port chooser when Connect is clicked without a selected port', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();

    const connect = fixture.nativeElement.querySelector('.connection-button') as HTMLButtonElement;
    connect.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('.serial-port-dialog') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Select serial port');
    expect(document.activeElement).toBe(dialog);

    const firstPort = dialog?.querySelector('input[value="COM4"]') as HTMLInputElement;
    firstPort.click();
    fixture.detectChanges();
    const confirm = dialog?.querySelector('footer .button.primary') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(TestBed.inject(WorkbenchStore).connection()).toMatchObject({
      status: 'connected',
      portPath: 'COM4',
    });
    expect(fixture.nativeElement.querySelector('.serial-port-dialog')).toBeNull();
  });

  it('rejects a stale saved port and restores focus when Escape closes the chooser', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const store = TestBed.inject(WorkbenchStore);
    store.selectedPort.set('COM99');

    const connect = fixture.nativeElement.querySelector('.connection-button') as HTMLButtonElement;
    connect.focus();
    connect.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const dialog = fixture.nativeElement.querySelector('.serial-port-dialog') as HTMLElement;
    const confirm = dialog.querySelector('footer .button.primary') as HTMLButtonElement;
    expect(store.selectedPort()).toBe('');
    expect(confirm.disabled).toBe(true);

    dialog.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
    );
    const footerSecondaryButtons = [
      ...dialog.querySelectorAll<HTMLButtonElement>('footer .button.secondary'),
    ];
    expect(document.activeElement).toBe(footerSecondaryButtons.at(-1));

    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.serial-port-dialog')).toBeNull();
    expect(document.activeElement).toBe(connect);
    fixture.destroy();
  });

  it('keeps the refresh control focused while a port scan is in progress', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const store = TestBed.inject(WorkbenchStore);
    store.serialPortDialogOpen.set(true);
    store.serialPortsRefreshing.set(true);
    fixture.detectChanges();
    await fixture.whenStable();

    const refresh = fixture.nativeElement.querySelector(
      '.serial-port-dialog footer .button.secondary',
    ) as HTMLButtonElement;
    refresh.focus();

    expect(refresh.disabled).toBe(false);
    expect(refresh.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(refresh);
    fixture.destroy();
  });
});
