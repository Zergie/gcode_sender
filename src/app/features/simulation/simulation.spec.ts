import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { SimulationComponent } from './simulation';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { TrendChartComponent } from '../../shared/trend-chart';

describe('SimulationComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SimulationComponent] }).compileComponents();
  });

  it('runs deterministic PID and model-assisted variants', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.run(false);
    const result = component.comparison();
    expect(result?.entries.map((entry) => entry.id)).toEqual(['pid', 'assisted']);
    expect(result?.entries.every((entry) => entry.result.execution.fixedStepSeconds === 0.25)).toBe(
      true,
    );
    fixture.destroy();
  });

  it('single-steps without changing the fixed solver step', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.reset();
    const before = component.cursor();
    component.step();
    expect(component.cursor()).toBe(before + 1);
    expect(component.activeEntry()?.result.execution.fixedStepSeconds).toBe(0.25);
    fixture.destroy();
  });

  it('renders the alternate controller trace and accessible playback state', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
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

  it('edits the physical heater response-time parameters', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.advanced.set(true);
    fixture.detectChanges();

    component.updateHeaterResponseTime('topHeater', 58);
    component.updateHeaterResponseTime('bottomHeater', 63);

    expect(fixture.nativeElement.textContent).toContain('Top heater response time (s)');
    expect(fixture.nativeElement.textContent).toContain('Bottom heater response time (s)');
    expect(fixture.nativeElement.textContent).toContain(
      'Models the delay between GPIO power and heat entering each oven zone.',
    );
    expect(component.profile().topHeater.responseTimeSeconds).toBe(58);
    expect(component.profile().bottomHeater.responseTimeSeconds).toBe(63);
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
