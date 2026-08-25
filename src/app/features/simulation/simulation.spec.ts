import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, vi } from 'vitest';
import { SimulationComponent } from './simulation';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { ConfigurationStore } from '../../core/configuration/configuration.store';
import { TrendChartComponent } from '../../shared/trend-chart';
import {
  DEFAULT_SIMULATION_CONTROLLER,
  compareSimulations,
  type SimulationComparisonResult,
} from '../../core/simulation';
import type { GcodeApi } from '../../../../shared/contracts';
import {
  FIRMWARE_WASM_ABI,
  type PreparedFirmware,
  type VirtualHardwareConfiguration,
} from '../../../../shared/firmware-contracts';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from './simulation-worker.protocol';
import { TEST_FIRMWARE_RUNTIME } from '../../core/simulation/firmware-in-loop/firmware-in-loop.fixture';

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
  const comparison = compareSimulations({
    profile: component.profile(),
    scenario: {
      durationSeconds: 60,
      initialTemperatureC: component.profile().ambientTemperatureC,
      targets: [{ atSeconds: 0, targetC: component.target() }],
      sampleEverySeconds: 5,
    },
    variants: [
      {
        id: 'pid',
        label: 'Firmware PID',
        controller: {
          ...DEFAULT_SIMULATION_CONTROLLER,
          mode: 'pid',
          pid: {
            ...DEFAULT_SIMULATION_CONTROLLER.pid,
            schedule: component.store.pidSchedule(),
          },
        },
      },
      {
        id: 'assisted',
        label: 'Firmware + physical feed-forward',
        controller: {
          ...DEFAULT_SIMULATION_CONTROLLER,
          mode: 'model-assisted-pid',
          pid: {
            ...DEFAULT_SIMULATION_CONTROLLER.pid,
            schedule: component.store.pidSchedule(),
          },
        },
      },
    ],
    baselineId: 'pid',
    controllerRuntime: TEST_FIRMWARE_RUNTIME,
  });
  component.comparison.set(comparison);
  component.cursor.set(comparison.entries[0]?.result.samples.length ?? 0);
  component.paused.set(true);
}

function startFirmwareWorker(component: SimulationComponent): void {
  component.preparedFirmware.set(preparedFirmwareFixture(component.firmwareHardware()));
  component.run(false, false);
}

function preparedFirmwareFixture(
  hardware: VirtualHardwareConfiguration,
  cacheHit = true,
): PreparedFirmware {
  return {
    artifact: {
      abi: FIRMWARE_WASM_ABI,
      buildId: 'fixture-build',
      sourceSha256: '1234567890abcdef',
      wasmBytes: new Uint8Array([0, 97, 115, 109]),
    },
    source: {
      path: 'C:\\fixtures\\main.ino',
      displayName: 'main.ino',
      sha256: '1234567890abcdef',
      files: ['main.ino', 'sTune.cpp', 'sTune.h'],
    },
    discoveredPins: [],
    suggestedHardware: hardware,
    toolchain: {
      available: true,
      selected: 'local-em++',
      adapters: [
        {
          kind: 'local-em++',
          available: true,
          displayName: 'Local Emscripten',
          version: '4.0.0',
          detail: 'Ready',
        },
      ],
    },
    diagnostics: [],
    provenance: {
      compiler: { adapter: 'local-em++', identity: 'em++ fixture', version: '4.0.0' },
      shim: {
        abi: FIRMWARE_WASM_ABI,
        version: '1.0.0',
        sha256: 'shim1234',
      },
      libraries: {},
      flags: ['-O2'],
      sourceTransforms: ['arduino-preprocess-v1'],
    },
    cacheHit,
    fidelity: 'source-level firmware logic with semantic peripheral emulation',
  };
}

describe('SimulationComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'gcode');
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

    startFirmwareWorker(component);
    fixture.detectChanges();

    const worker = SimulationWorkerStub.instances[0]!;
    const request = worker.messages[0]!;
    expect(component.simulationBusy()).toBe(true);
    expect(component.comparison()).toBeNull();
    expect(request.request.variants.map((variant) => variant.id)).toEqual(['pid', 'assisted']);
    expect(fixture.nativeElement.textContent).toContain(
      'Running firmware against the physical twin',
    );
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
    startFirmwareWorker(component);
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

  it('terminates an unresponsive worker at the five-minute wall-clock deadline', () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    startFirmwareWorker(component);
    const worker = SimulationWorkerStub.instances[0]!;

    vi.advanceTimersByTime(5 * 60 * 1_000 - 1);
    expect(component.simulationBusy()).toBe(true);
    expect(worker.terminated).toBe(false);

    vi.advanceTimersByTime(1);
    expect(worker.terminated).toBe(true);
    expect(component.simulationBusy()).toBe(false);
    expect(component.simulationError()).toMatch(/5 minute.*terminated/i);
    fixture.destroy();
  });

  it('clears or replaces the worker deadline on success, a new run, cancel, and destroy', () => {
    const fallbackFixture = TestBed.createComponent(SimulationComponent);
    runShortSynchronousComparison(fallbackFixture.componentInstance);
    const fallbackResult = fallbackFixture.componentInstance.comparison();
    expect(fallbackResult).not.toBeNull();
    fallbackFixture.destroy();

    vi.useFakeTimers();
    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    startFirmwareWorker(component);
    const firstWorker = SimulationWorkerStub.instances[0]!;
    const firstRequest = firstWorker.messages[0]!;
    expect(vi.getTimerCount()).toBe(1);

    firstWorker.respond({
      kind: 'success',
      token: firstRequest.token,
      result: fallbackResult!,
    });
    expect(vi.getTimerCount()).toBe(0);

    component.run(false, false);
    const replacedWorker = SimulationWorkerStub.instances[1]!;
    component.run(false, false);
    expect(replacedWorker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    component.cancelRun();
    expect(vi.getTimerCount()).toBe(0);

    component.run(false, false);
    expect(vi.getTimerCount()).toBe(1);
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces worker failures without replacing the last valid comparison', () => {
    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    startFirmwareWorker(component);
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

    TestBed.inject(ConfigurationStore).setFirmware(
      preparedFirmwareFixture(component.firmwareHardware()),
    );
    component.useForControl();

    expect(store.activeProfile()).toBe('Bench oven model');
    expect(store.modelAssistance().maximumTargetLeadC).toBe(9);
    expect(store.controlMode()).toBe('model-assisted');
    expect(store.controlArmed()).toBe(false);
    fixture.destroy();
  });

  it('prefills and validates the supported STM32 virtual GPIO mapping', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;

    component.firmwareAdvanced.set(true);
    fixture.detectChanges();

    expect(component.firmwareHardware().pins.map((binding) => binding.pin)).toEqual([
      'PA6',
      'PA0',
      'PA5',
      'PB9',
      'PC13',
      'PA10',
      'PA9',
    ]);
    expect(component.firmwareConfigurationError()).toBe('Choose and build an Arduino .ino sketch.');
    expect(fixture.nativeElement.textContent).toContain(
      'The selected Arduino sketch is the only controller',
    );
    expect(fixture.nativeElement.textContent).toContain('Virtual GPIO mapping');
    expect(fixture.nativeElement.textContent).toContain(
      'Firmware output drive is verified when the simulation starts',
    );
    expect(fixture.nativeElement.textContent).toContain('reference → VCC · NTC → GND');
    const labels = [...fixture.nativeElement.querySelectorAll('label')] as HTMLLabelElement[];
    const adcResolution = [...fixture.nativeElement.querySelectorAll('.derived-value')].find(
      (element: Element) => element.textContent?.includes('ADC output'),
    );
    expect(adcResolution?.querySelector('input')).toBeNull();
    expect(adcResolution?.textContent).toContain('12-bit fixed · 0–4095');
    const eepromSize = labels.find((label) => label.textContent?.includes('Size (bytes)'));
    expect(eepromSize?.querySelector('input')?.getAttribute('min')).toBe('33');
    fixture.destroy();
  });

  it('loads a prepared artifact, exposes build state, and invalidates prior firmware results', async () => {
    const pickAndBuild = vi.fn();
    const toolchain = {
      available: true,
      selected: 'local-em++' as const,
      adapters: [
        {
          kind: 'local-em++' as const,
          available: true,
          displayName: 'Local Emscripten',
          version: '4.0.0',
          detail: 'Ready',
        },
      ],
    };
    Object.defineProperty(window, 'gcode', {
      configurable: true,
      value: {
        firmware: {
          getToolchainStatus: vi.fn().mockResolvedValue({ ok: true, value: toolchain }),
          pickAndBuild,
        },
      } as unknown as GcodeApi,
    });
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);
    const staleComparison = component.comparison();
    expect(staleComparison).not.toBeNull();
    component.comparison.set(staleComparison);
    component.cursor.set(4);
    component.paused.set(false);
    component.appendFirmwareOutput({
      timeSeconds: 1,
      direction: 'tx',
      text: 'old artifact output',
    });
    const hardware: VirtualHardwareConfiguration = component.firmwareHardware();
    const prepared: PreparedFirmware = {
      artifact: {
        abi: FIRMWARE_WASM_ABI,
        buildId: 'fixture-build',
        sourceSha256: '1234567890abcdef',
        wasmBytes: new Uint8Array([0, 97, 115, 109]),
      },
      source: {
        path: 'C:\\fixtures\\main.ino',
        displayName: 'main.ino',
        sha256: '1234567890abcdef',
        files: ['main.ino', 'sTune.cpp', 'sTune.h'],
      },
      discoveredPins: [],
      suggestedHardware: hardware,
      toolchain,
      diagnostics: [],
      provenance: {
        compiler: { adapter: 'local-em++', identity: 'em++ fixture', version: '4.0.0' },
        shim: {
          abi: FIRMWARE_WASM_ABI,
          version: '1.0.0',
          sha256: 'shim1234',
        },
        libraries: {},
        flags: ['-O2'],
        sourceTransforms: ['arduino-preprocess-v1'],
      },
      cacheHit: true,
      fidelity: 'source-level firmware logic with semantic peripheral emulation',
    };
    pickAndBuild.mockResolvedValue({
      ok: true,
      value: { status: 'ready', firmware: prepared },
    });

    await component.chooseFirmware();
    fixture.detectChanges();

    expect(component.preparedFirmware()).toBe(prepared);
    expect(component.firmwareConfigurationError()).toBeNull();
    expect(component.comparison()).toBeNull();
    expect(component.cursor()).toBe(0);
    expect(component.paused()).toBe(true);
    expect(component.firmwareOutput().some(({ text }) => text === 'old artifact output')).toBe(
      false,
    );
    expect(component.firmwareOutput().at(-1)?.text).toContain('cached build');
    expect(fixture.nativeElement.textContent).toContain('Cache hit');
    expect(fixture.nativeElement.textContent).toContain('Local Emscripten');
    fixture.destroy();
  });

  it('invalidates displayed results for every virtual-hardware mutation path', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);
    const staleComparison = component.comparison();
    expect(staleComparison).not.toBeNull();
    const prepared = preparedFirmwareFixture(component.firmwareHardware());
    component.preparedFirmware.set(prepared);
    const originalHardware = prepared.suggestedHardware;

    const seedStaleResult = (): void => {
      component.comparison.set(staleComparison);
      component.cursor.set(4);
      component.paused.set(false);
      component.appendFirmwareOutput({
        timeSeconds: 1,
        direction: 'tx',
        text: 'stale output',
      });
    };
    const expectInvalidated = (name: string): void => {
      expect(component.comparison(), name).toBeNull();
      expect(component.cursor(), name).toBe(0);
      expect(component.paused(), name).toBe(true);
      expect(component.firmwareOutput(), name).toEqual([]);
    };
    const mutations: ReadonlyArray<{
      readonly name: string;
      readonly prepare?: () => void;
      readonly mutate: () => void;
    }> = [
      { name: 'pin name', mutate: () => component.updateFirmwarePinName(0, 'PA7') },
      {
        name: 'pin role',
        mutate: () => component.updateFirmwarePinRole(4, 'digital-input'),
      },
      {
        name: 'output polarity',
        mutate: () => component.updateFirmwarePinPolarity(3, 'low'),
      },
      {
        name: 'analog input',
        prepare: () =>
          component.setFirmwareHardware({
            ...originalHardware,
            pins: originalHardware.pins.map((binding, index) =>
              index === 4 ? { kind: 'analog-input', pin: binding.pin, rawValue: 0 } : binding,
            ),
          }),
        mutate: () => component.updateFirmwareAnalogValue(4, 1_234),
      },
      { name: 'add GPIO', mutate: () => component.addGenericFirmwarePin() },
      { name: 'remove GPIO', mutate: () => component.removeFirmwarePin(4) },
      { name: 'restore mapping', mutate: () => component.resetKnownFirmwareMapping() },
      {
        name: 'NTC transfer',
        mutate: () => component.updateFirmwareNtc('betaK', 4_000),
      },
      {
        name: 'EEPROM size',
        mutate: () => component.updateFirmwareEepromSize(2_048),
      },
      { name: 'EEPROM fill', mutate: () => component.updateFirmwareEepromFill(0) },
    ];

    for (const mutation of mutations) {
      component.setFirmwareHardware(originalHardware);
      mutation.prepare?.();
      seedStaleResult();
      mutation.mutate();
      expectInvalidated(mutation.name);
    }
    fixture.destroy();
  });

  it('cancels an active comparison when a scenario parameter changes', () => {
    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    startFirmwareWorker(component);
    const worker = SimulationWorkerStub.instances[0]!;
    component.appendFirmwareOutput({ timeSeconds: 0, direction: 'system', text: 'stale' });

    component.updateTarget(180);

    expect(worker.terminated).toBe(true);
    expect(component.simulationBusy()).toBe(false);
    expect(component.comparison()).toBeNull();
    expect(component.cursor()).toBe(0);
    expect(component.paused()).toBe(true);
    expect(component.firmwareOutput()).toEqual([]);
    fixture.destroy();
  });

  it('invalidates displayed results for scenario, model, and controller mutations', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);
    const staleComparison = component.comparison();
    expect(staleComparison).not.toBeNull();

    const seedStaleResult = (): void => {
      component.comparison.set(staleComparison);
      component.cursor.set(4);
      component.paused.set(false);
      component.appendFirmwareOutput({ timeSeconds: 1, direction: 'system', text: 'stale' });
    };
    const mutations: ReadonlyArray<readonly [string, () => void]> = [
      ['target', () => component.updateTarget(190)],
      ['duration', () => component.updateDuration(20)],
      ['profile', () => component.updateProfile('ambientTemperatureC', 23)],
      ['controller assistance', () => component.updateAssistance('maximumTargetLeadC', 20)],
      ['geometry', () => component.updateGeometryMm('widthM', 450)],
      ['heater power', () => component.updateHeaterRatedPower('top', 900)],
      ['body heat capacity', () => component.updateBodyHeatCapacity('standardLoad', 12_000)],
      ['linear heat transfer', () => component.updateLinearConductance(0, 4)],
      ['radiation', () => component.updateRadiation(0, 'emissivity', 0.8)],
      ['radiation area', () => component.updateRadiationAreaCm2(0, 1_200)],
      ['ambient boundary', () => component.updateAmbient('enclosureConductanceWPerK', 5)],
    ];

    for (const [name, mutate] of mutations) {
      seedStaleResult();
      mutate();
      expect(component.comparison(), name).toBeNull();
      expect(component.cursor(), name).toBe(0);
      expect(component.paused(), name).toBe(true);
      expect(component.firmwareOutput(), name).toEqual([]);
    }
    fixture.destroy();
  });

  it('keeps firmware history non-live and exposes only a concise output status', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.appendFirmwareOutput({ timeSeconds: 1, direction: 'tx', text: 'ready' });
    fixture.detectChanges();

    const history = fixture.debugElement.query(By.css('.firmware-output')).nativeElement;
    const status = fixture.debugElement.query(By.css('.firmware-output-status')).nativeElement;
    expect(history.getAttribute('role')).toBe('log');
    expect(history.getAttribute('aria-live')).toBe('off');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('1 record ready');

    component.simulationError.set('The new run failed.');
    fixture.detectChanges();
    expect(status.textContent).toContain('1 record preserved from before the failed run');
    fixture.destroy();
  });

  it('exposes only firmware-in-the-loop control and queues terminal UART lines for the next run', () => {
    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.preparedFirmware.set(preparedFirmwareFixture(component.firmwareHardware()));
    component.firmwareTerminalInput.set('M105');
    component.firmwareTerminalTimeSeconds.set(12.5);
    component.queueFirmwareTerminalCommand();
    fixture.detectChanges();

    expect(component.firmwareTerminalCommands()).toEqual([
      expect.objectContaining({ atSeconds: 12.5, command: 'M105' }),
    ]);
    expect(fixture.nativeElement.textContent).toContain('Simulated controller terminal');
    expect(fixture.nativeElement.textContent).not.toContain('Built-in');

    component.run(false, false);
    const request = SimulationWorkerStub.instances.at(-1)?.messages[0]?.request;
    expect(request?.scenario.serialCommands).toEqual([{ atSeconds: 12.5, command: 'M105' }]);
    fixture.destroy();
  });

  it('starts terminal interaction at 1x and resumes a running simulation at its selected speed', () => {
    const fallbackFixture = TestBed.createComponent(SimulationComponent);
    runShortSynchronousComparison(fallbackFixture.componentInstance);
    const result = fallbackFixture.componentInstance.comparison()!;
    fallbackFixture.destroy();

    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.preparedFirmware.set(preparedFirmwareFixture(component.firmwareHardware()));
    component.timewarp.set(100);
    component.firmwareTerminalInput.set('M105');

    component.sendFirmwareTerminalCommand();

    const idleWorker = SimulationWorkerStub.instances[0]!;
    const idleRequest = idleWorker.messages[0]!;
    expect(component.timewarp()).toBe(1);
    expect(idleRequest.request.scenario.serialCommands).toEqual([
      { atSeconds: 0, command: 'M105' },
    ]);
    idleWorker.respond({ kind: 'success', token: idleRequest.token, result });

    component.togglePlayback();
    component.cursor.set(5);
    component.timewarp.set(20);
    const resumeAtSeconds = component.currentSample()!.timeSeconds;
    component.firmwareTerminalInput.set('M503');
    component.sendFirmwareTerminalCommand();

    const runningWorker = SimulationWorkerStub.instances[1]!;
    const runningRequest = runningWorker.messages[0]!;
    expect(component.timewarp()).toBe(20);
    expect(runningRequest.request.scenario.serialCommands?.at(-1)).toEqual({
      atSeconds: resumeAtSeconds,
      command: 'M503',
    });
    runningWorker.respond({ kind: 'success', token: runningRequest.token, result });
    expect(component.currentSample()?.timeSeconds).toBeGreaterThanOrEqual(resumeAtSeconds);
    expect(component.timewarp()).toBe(20);
    fixture.destroy();
  });

  it('sends the selected artifact and virtual hardware to the simulation worker', () => {
    vi.stubGlobal('Worker', SimulationWorkerStub);
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.cancelRun();
    const prepared = preparedFirmwareFixture(component.firmwareHardware());
    component.preparedFirmware.set(prepared);

    component.run(false, false);

    const request = SimulationWorkerStub.instances.at(-1)?.messages[0]?.request;
    expect(request?.controllerRuntime).toEqual({
      kind: 'wasm-firmware',
      artifact: prepared.artifact,
      hardware: component.firmwareHardware(),
    });
    expect(request?.variants.map((variant) => variant.label)).toEqual([
      'Firmware PID',
      'Firmware + physical feed-forward',
    ]);
    fixture.destroy();
  });

  it('never falls back to running selected firmware on the renderer thread', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.preparedFirmware.set(preparedFirmwareFixture(component.firmwareHardware()));

    component.run(false, false);

    expect(component.comparison()).toBeNull();
    expect(component.simulationBusy()).toBe(false);
    expect(component.simulationError()).toContain('requires an isolated simulation worker');
    fixture.destroy();
  });

  it('renders bounded serial, GPIO and reset observations from a firmware result', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    runShortSynchronousComparison(component);
    const comparison = component.comparison();
    expect(comparison).not.toBeNull();
    component.comparison.set({
      ...comparison!,
      entries: comparison!.entries.map((entry) => ({
        ...entry,
        result: {
          ...entry.result,
          firmware: {
            buildId: 'fixture-build',
            serialTranscript: [
              { timeSeconds: 0.1, direction: 'rx', text: 'M115' },
              { timeSeconds: 0.2, direction: 'tx', text: 'FIRMWARE_NAME:fixture' },
            ],
            indicatorSamples: [
              {
                intervalStartSeconds: 0.2,
                timeSeconds: 0.3,
                indicators: {
                  'status-led': {
                    pin: 'PC13',
                    level: 'low',
                    active: true,
                    activeFraction: 0.75,
                  },
                },
              },
            ],
            resetCount: 1,
            truncation: {
              droppedSerialEvents: 2,
              droppedSerialBytes: 48,
              droppedIndicatorSamples: 3,
            },
          },
        },
      })),
    });

    component.selectVariant('assisted');
    fixture.detectChanges();

    expect(component.firmwareOutput().map((line) => line.direction)).toEqual([
      'rx',
      'tx',
      'gpio',
      'system',
      'system',
    ]);
    expect(fixture.nativeElement.textContent).toContain('FIRMWARE_NAME:fixture');
    expect(fixture.nativeElement.textContent).toContain('status-led (PC13) ended active');
    expect(fixture.nativeElement.textContent).toContain('75.0% active over 0.100 s');
    expect(fixture.nativeElement.textContent).toContain('1 virtual MCU reset observed');
    expect(fixture.nativeElement.textContent).toContain('Output capture limit reached');
    const summaryRows = [...fixture.nativeElement.querySelectorAll('.firmware-output .system')];
    expect(summaryRows).toHaveLength(2);
    expect(
      summaryRows.every(
        (row) => row.querySelector('.firmware-output-summary')?.textContent === 'SUMMARY',
      ),
    ).toBe(true);
    expect(summaryRows.every((row) => !row.textContent.includes('60.000 s'))).toBe(true);
    fixture.destroy();
  });

  it('rejects noncanonical and duplicate pins and bounds firmware output', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.preparedFirmware.set({} as PreparedFirmware);

    component.updateFirmwarePinName(0, 'GPIO1');
    expect(component.firmwareConfigurationError()).toContain('PA0 through PC15');
    component.updateFirmwarePinName(0, 'PA0');
    expect(component.firmwareConfigurationError()).toContain('assigned more than once');

    for (let index = 0; index < 305; index += 1) {
      component.appendFirmwareOutput({
        timeSeconds: index,
        direction: 'tx',
        text: `line-${index}`,
      });
    }
    expect(component.firmwareOutput()).toHaveLength(300);
    expect(component.firmwareOutput()[0]?.text).toBe('line-5');
    fixture.destroy();
  });

  it('uses the runtime virtual-hardware validator before enabling a firmware run', () => {
    const fixture = TestBed.createComponent(SimulationComponent);
    const component = fixture.componentInstance;
    component.preparedFirmware.set(preparedFirmwareFixture(component.firmwareHardware()));

    component.updateFirmwarePinRole(4, 'analog-input');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#firmware-adc-4')?.getAttribute('max')).toBe(
      '4095',
    );
    component.updateFirmwareAnalogValue(4, 65_536);
    expect(component.firmwareConfigurationError()).toContain('integer from 0 through 4095');

    component.resetKnownFirmwareMapping();
    component.updateFirmwareNtc('nominalTemperatureC', -273.15);
    expect(component.firmwareConfigurationError()).toContain('above absolute zero');

    component.resetKnownFirmwareMapping();
    component.updateFirmwareHardware((hardware) => ({
      ...hardware,
      eeprom: { ...hardware.eeprom, initialFill: 1 as 0 },
    }));
    expect(component.firmwareConfigurationError()).toContain('initialFill must be 0 or 255');
    fixture.destroy();
  });
});
