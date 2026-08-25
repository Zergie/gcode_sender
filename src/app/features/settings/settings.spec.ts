import { TestBed } from '@angular/core/testing';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { SettingsComponent } from './settings';

describe('SettingsComponent simulation configuration', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SettingsComponent] }).compileComponents();
  });

  it('orders appearance, hardware, firmware configuration, session start, and streaming', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.detectChanges();
    const headings = [
      ...fixture.nativeElement.querySelectorAll('.settings-main .panel-kicker'),
    ].map((element: Element) => element.textContent?.trim());
    expect(headings).toEqual([
      'APPEARANCE',
      'HARDWARE',
      'FIRMWARE',
      'ROOM & ELECTRICAL INPUT',
      'VIRTUAL GPIO MAPPING',
      'ADDITIONAL MODEL PARAMETERS',
      'EXECUTION SAFETY',
      'SESSION START',
      'STREAMING',
    ]);
  });

  it('edits the same physical model and GPIO configuration used by the workbench', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    const component = fixture.componentInstance;
    const store = TestBed.inject(WorkbenchStore);

    component.updateHeaterPower('top', 1_100);
    component.updateFirmwarePin(0, 'pb1');
    component.updateGeometry('widthM', 95);

    expect(store.ovenModelProfile().heaters.top.ratedPowerW).toBe(1_100);
    expect(store.firmwareInLoopHardware().pins[0]?.pin).toBe('PB1');
    expect(store.ovenModelProfile().geometry.widthM).toBeCloseTo(0.095, 10);
  });

  it('presents and saves the three bounded execution limits separately', async () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    const component = fixture.componentInstance;
    component.physicalLineLimitBytes.set(128_000);
    component.artifactLimitBytes.set(8_000_000);
    component.artifactLimitRecords.set(25_000);
    await component.saveRuntimeSettings();

    expect(TestBed.inject(WorkbenchStore).settings()).toMatchObject({
      physicalLineLimitBytes: 128_000,
      artifactLimitBytes: 8_000_000,
      artifactLimitRecords: 25_000,
    });
    expect(fixture.nativeElement.textContent).toContain('do not limit total job size');
  });
});
