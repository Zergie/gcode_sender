import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, vi } from 'vitest';
import { SimulationComponent } from './simulation';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { TrendChartComponent } from '../../shared/trend-chart';
import type { SimulationComparisonResult } from '../../core/simulation';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from './simulation-worker.protocol';

class SimulationWorkerStub {
  static instances: SimulationWorkerStub[] = [];

  onmessage: ((event: MessageEvent<SimulationWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: SimulationWorkerRequest[] = [];
  terminated = false;

  constructor() {
    SimulationWorkerStub.instances.push(this);
  }

  postMessage(message: SimulationWorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: SimulationWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }));
  }
}

function runShortSynchronousComparison(component: SimulationComponent): void {
  component.updateDuration(1);
  component.run(false, false);
}

describe('SimulationComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    SimulationWorkerStub.instances = [];
  });

  beforeEach(async () => {
    vi.stubGlobal('Worker', undefined);
    await TestBed.configureTestingModule({ imports: [SimulationComponent] }).compileComponents();
  });

  it('runs deterministic PID and model-assisted variants', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);
    const result = component.comparison();
    expect(result?.entries.map((entry) => entry.id)).toEqual(['pid', 'assisted']);
    expect(
      result?.entries.every(
        (entry) =>
          entry.result.execution.fixedStepSeconds === component.profile().solverStepSeconds,
      ),
    ).toBe(true);
    fixture.destroy();
  });

  it('runs production comparisons in a worker and applies the matching result', () => {
    const fallbackFixture = TestBed.createComponent(SimulationComponent);
    runShortSynchronousComparison(fallbackFixture.componentInstance);
    const fallbackResult = fallbackFixture.componentInstance.comparison();
    expect(fallbackResult).not.toBeNull();
    fallbackFixture.destroy();

    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    fixture.detectChanges();

    const worker = SimulationWorkerStub.instances[0]!;
    const request = worker.messages[0]!;
    expect(component.simulationBusy()).toBe(true);
    expect(component.comparison()).toBeNull();
    expect(request.request.variants.map((variant) => variant.id)).toEqual(['pid', 'assisted']);
    expect(fixture.nativeElement.textContent).toContain('Calculating the physical twin');
    expect(fixture.nativeElement.textContent).toContain('outside the UI thread');

    worker.respond({
      kind: 'success',
      token: request.token,
      result: fallbackResult as SimulationComparisonResult,
    });

    expect(component.simulationBusy()).toBe(false);
    expect(component.comparison()).toBe(fallbackResult);
    expect(worker.terminated).toBe(true);
    fixture.destroy();
  });

  it('terminates cancelled workers and ignores stale run tokens', () => {
    const fallbackFixture = TestBed.createComponent(SimulationComponent);
    runShortSynchronousComparison(fallbackFixture.componentInstance);
    const fallbackResult = fallbackFixture.componentInstance.comparison();
    expect(fallbackResult).not.toBeNull();
    fallbackFixture.destroy();

    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    const staleWorker = SimulationWorkerStub.instances[0]!;
    const staleRequest = staleWorker.messages[0]!;
    const staleHandler = staleWorker.onmessage;

    component.run(false, false);
    const activeWorker = SimulationWorkerStub.instances[1]!;
    const activeRequest = activeWorker.messages[0]!;
    expect(staleWorker.terminated).toBe(true);

    staleHandler?.(
      new MessageEvent('message', {
        data: {
          kind: 'success',
          token: staleRequest.token,
          result: fallbackResult as SimulationComparisonResult,
        } satisfies SimulationWorkerResponse,
      }),
    );
    expect(component.comparison()).toBeNull();
    expect(component.simulationBusy()).toBe(true);

    activeWorker.respond({
      kind: 'success',
      token: activeRequest.token,
      result: fallbackResult as SimulationComparisonResult,
    });
    expect(component.comparison()).toBe(fallbackResult);

    component.run(false, false);
    const cancelledWorker = SimulationWorkerStub.instances[2]!;
    component.cancelRun();
    expect(cancelledWorker.terminated).toBe(true);
    expect(component.simulationBusy()).toBe(false);

    component.run(false, false);
    const destroyedWorker = SimulationWorkerStub.instances[3]!;
    fixture.destroy();
    expect(destroyedWorker.terminated).toBe(true);
  });

  it('surfaces worker failures without replacing the last valid comparison', () => {
    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    const worker = SimulationWorkerStub.instances[0]!;
    const request = worker.messages[0]!;

    worker.respond({ kind: 'failure', token: request.token, error: 'Solver exploded.' });
    fixture.detectChanges();

    expect(component.simulationBusy()).toBe(false);
    expect(component.simulationError()).toBe('Solver exploded.');
    expect(component.comparison()).toBeNull();
    expect(worker.terminated).toBe(true);
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Solver exploded.',
    );
    fixture.destroy();
  });

  it('single-steps without changing the fixed solver step', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);
    component.reset();
    const before = component.cursor();
    component.step();
    expect(component.cursor()).toBe(before + 1);
    expect(component.activeEntry()?.result.execution.fixedStepSeconds).toBe(
      component.profile().solverStepSeconds,
    );
    fixture.destroy();
  });

  it('maps literal timewarp to sample timestamps without changing the physics', () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);

    component.reset();
    component.selectWarp(1);
    component.togglePlayback();
    vi.advanceTimersByTime(4_950);
    expect(component.currentSample()?.timeSeconds).toBe(0);
    vi.advanceTimersByTime(50);
    expect(component.currentSample()?.timeSeconds).toBe(5);

    component.reset();
    component.selectWarp(20);
    component.togglePlayback();
    vi.advanceTimersByTime(1_000);
    expect(component.currentSample()?.timeSeconds).toBe(20);
    expect(component.activeEntry()?.result.execution.fixedStepSeconds).toBe(
      component.profile().solverStepSeconds,
    );

    component.selectWarp('maximum');
    expect(component.cursor()).toBe(component.activeEntry()?.result.samples.length);
    expect(component.paused()).toBe(true);
    fixture.destroy();
  });

  it('renders the alternate controller trace and accessible playback state', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    runShortSynchronousComparison(fixture.componentInstance);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const trendChart = fixture.debugElement.query(By.directive(TrendChartComponent))
      .componentInstance as TrendChartComponent;

    expect(component.comparisonTrend().length).toBe(component.visibleTrend().length);
    expect(trendChart.comparisonPoints().length).toBeGreaterThan(0);
    expect(fixture.nativeElement.querySelector('.comparison-legend')).not.toBeNull();
    expect(
      fixture.nativeElement.querySelector('.playback-progress')?.getAttribute('aria-label'),
    ).toBe('Simulation playback position');
    fixture.destroy();
  });

  it('does not declare a winner when controller results are tied', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);
    const comparison = component.comparison();
    expect(comparison).not.toBeNull();
    const baseline = comparison!.entries[0]!;
    const candidate = comparison!.entries[1]!;
    component.comparison.set({
      ...comparison!,
      entries: [baseline, { ...candidate, result: baseline.result }],
    });

    expect(component.preferredVariantId()).toBeNull();
    expect(component.comparisonInsight()).toEqual(
      expect.objectContaining({
        kind: 'equivalent',
        title: 'No measurable response difference in this scenario',
      }),
    );
    fixture.destroy();
  });

  it('describes differing traces neutrally when displayed RMSE is tied', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);
    const comparison = component.comparison();
    expect(comparison).not.toBeNull();
    const baseline = comparison!.entries[0]!;
    const candidate = comparison!.entries[1]!;
    component.comparison.set({
      ...comparison!,
      entries: [
        baseline,
        {
          ...candidate,
          result: {
            ...candidate.result,
            samples: candidate.result.samples.map((sample, index) =>
              index === 1
                ? {
                    ...sample,
                    temperatures: {
                      ...sample.temperatures,
                      t0C: sample.temperatures.t0C + 0.1,
                    },
                  }
                : sample,
            ),
            metrics: {
              ...candidate.result.metrics,
              rootMeanSquareErrorC: baseline.result.metrics.rootMeanSquareErrorC + 0.001,
            },
          },
        },
      ],
    });

    expect(component.preferredVariantId()).toBeNull();
    expect(component.comparisonInsight()).toEqual(
      expect.objectContaining({
        kind: 'different',
        title: 'Controllers predict different responses',
        detail: expect.stringContaining('RMSE is equal at displayed precision'),
      }),
    );
    fixture.destroy();
  });

  it('renders the versioned physical twin summary without artificial lag controls', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.advanced.set(true);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('TWIN v1');
    expect(text).toContain('80 × 220 × 60 mm chamber');
    expect(text).toContain('Geometry & heat storage');
    expect(text).toContain('Conduction & convection');
    expect(text).toContain('Radiation paths');
    expect(text).toContain('Thermistors');
    expect(text).toContain('there are no synthetic lag or waveform controls');
    expect(text).not.toContain('Actuator dead time');
    expect(text).not.toContain('heater response time');
    expect(text).not.toContain('sensor lag');
    fixture.destroy();
  });

  it('edits physical geometry, bodies, transfer links and ambient boundary', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    const initialAirCapacity = component.profile().bodies.topAir.heatCapacityJPerK;
    const initialEnclosureArea = component.profile().ambient.enclosureRadiatingAreaM2;
    const initialLoadLink = component
      .profile()
      .radiationLinks.find(
        (link) =>
          (link.a === 'standardLoad' && link.b === 'enclosure') ||
          (link.a === 'enclosure' && link.b === 'standardLoad'),
      );

    component.updateGeometryMm('widthM', 160);
    component.updateHeaterRatedPower('top', 1_000);
    component.updateBodyHeatCapacity('topHeater', 81);
    component.updateBodyHeatCapacity('standardLoad', 850);
    component.updateLinearConductance(0, 0.123);
    component.updateRadiationAreaCm2(0, 150);
    component.updateRadiation(0, 'emissivity', 0.72);
    component.updateAmbient('enclosureConductanceWPerK', 1.75);
    component.updateAmbient('t3AmbientConductanceWPerK', 0.18);

    const profile = component.profile();
    expect(profile.geometry.widthM).toBeCloseTo(0.16);
    expect(profile.bodies.topAir.heatCapacityJPerK).toBeCloseTo(initialAirCapacity * 2);
    expect(profile.bodies.bottomAir.heatCapacityJPerK).toBeCloseTo(
      profile.bodies.topAir.heatCapacityJPerK,
    );
    expect(profile.ambient.enclosureRadiatingAreaM2).toBeGreaterThan(initialEnclosureArea);
    expect(
      profile.radiationLinks.find(
        (link) =>
          (link.a === 'standardLoad' && link.b === 'enclosure') ||
          (link.a === 'enclosure' && link.b === 'standardLoad'),
      )?.areaM2,
    ).toBeCloseTo((initialLoadLink?.areaM2 ?? 0) * 2);
    expect(profile.heaters.top.ratedPowerW).toBe(1_000);
    expect(profile.bodies.topHeater.heatCapacityJPerK).toBe(81);
    expect(profile.bodies.standardLoad.heatCapacityJPerK).toBe(850);
    expect(profile.linearLinks[0]?.conductanceWPerK).toBe(0.123);
    expect(profile.radiationLinks[0]?.areaM2).toBeCloseTo(0.015);
    expect(profile.radiationLinks[0]?.emissivity).toBe(0.72);
    expect(profile.ambient.enclosureConductanceWPerK).toBe(1.75);
    expect(profile.ambient.t3AmbientConductanceWPerK).toBe(0.18);
    fixture.destroy();
  });

  it('labels heat-transfer mechanisms and explains physical feed-forward control', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.advanced.set(true);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Physical links');
    expect(text).toContain('Convection');
    expect(text).toContain('Grey-body exchange');
    expect(text).toContain('T3-to-room conductance (W/K)');
    expect(text).toContain('physical path that pulls the safety sensor toward ambient');
    expect(text).toContain('Physical feed-forward target');
    expect(text).toContain("this simulation's scenario target");
    expect(text).toContain('searches bounded whole-degree M104 commands');
    expect(text).toContain('never the plant physics');
    expect(text).not.toContain('Heating trajectory (°C/min)');
    expect(text).not.toContain('Cooling trajectory (°C/min)');
    fixture.destroy();
  });

  it('explicitly promotes the edited model without arming hardware control', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    const store = TestBed.inject(WorkbenchStore);
    component.updateProfile('name', 'Bench oven model');
    component.updateAssistance('maximumTargetLeadC', 9);

    component.useForControl();

    expect(store.activeProfile()).toBe('Bench oven model');
    expect(store.modelAssistance().maximumTargetLeadC).toBe(9);
    expect(store.controlMode()).toBe('model-assisted');
    expect(store.controlArmed()).toBe(false);
    fixture.destroy();
  });
});
