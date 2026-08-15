import { TestBed } from '@angular/core/testing';
import { SimulationComponent } from './simulation';
import { WorkbenchStore } from '../../core/platform/workbench.store';

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
