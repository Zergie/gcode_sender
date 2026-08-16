import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { TrendPoint } from '../core/platform/workbench.store';

interface ChartSeries {
  readonly average: string;
  readonly comparison: string;
  readonly target: string;
  readonly model: string;
  readonly t1: string;
  readonly t2: string;
  readonly t3: string;
  readonly area: string;
}

@Component({
  selector: 'app-trend-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="trend-wrap" role="img" aria-label="Temperature history chart">
      <svg viewBox="0 0 900 300" preserveAspectRatio="none">
        <defs>
          <linearGradient id="temperature-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--accent)" stop-opacity=".2" />
            <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        <g class="grid-lines">
          <path d="M44 22H884M44 84H884M44 146H884M44 208H884M44 270H884" />
          <path d="M44 22V270M254 22V270M464 22V270M674 22V270M884 22V270" />
        </g>
        <path class="area" [attr.d]="paths().area" />
        <path class="series t1" [attr.d]="paths().t1" />
        <path class="series t2" [attr.d]="paths().t2" />
        <path class="series t3" [attr.d]="paths().t3" />
        <path class="series requested" [attr.d]="paths().target" />
        @if (showModelTarget()) {
          <path class="series model" [attr.d]="paths().model" />
        }
        <path class="series comparison" [attr.d]="paths().comparison" />
        <path class="series average" [attr.d]="paths().average" />
        <g class="axis-labels">
          <text x="5" y="27">250°</text>
          <text x="12" y="89">188°</text>
          <text x="12" y="151">125°</text>
          <text x="20" y="213">63°</text>
          <text x="27" y="275">0°</text>
        </g>
      </svg>
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
    .trend-wrap {
      height: 100%;
      min-height: 210px;
    }
    .trend-wrap svg {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    .grid-lines path {
      stroke: var(--line);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .axis-labels {
      fill: var(--text-faint);
      font: 16px var(--font-mono);
    }
    .series {
      fill: none;
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }
    .series.average {
      stroke: var(--accent);
      stroke-width: 2.5;
    }
    .series.t1 {
      stroke: #f59e5b;
      opacity: 0.62;
    }
    .series.t2 {
      stroke: #bb86fc;
      opacity: 0.55;
    }
    .series.t3 {
      stroke: #69c6a4;
      opacity: 0.7;
    }
    .series.requested {
      stroke: var(--text-faint);
      stroke-dasharray: 7 5;
    }
    .series.model {
      stroke: #53b9e8;
      stroke-dasharray: 3 4;
    }
    .series.comparison {
      stroke: var(--purple);
      stroke-width: 2;
      stroke-dasharray: 9 5;
      opacity: 0.9;
    }
    .area {
      fill: url(#temperature-area);
      stroke: none;
    }
  `,
})
export class TrendChartComponent {
  readonly points = input.required<readonly TrendPoint[]>();
  readonly comparisonPoints = input<readonly TrendPoint[]>([]);
  readonly showModelTarget = input(true);
  readonly paths = computed<ChartSeries>(() => {
    const points = this.points();
    const make = (source: readonly TrendPoint[], pick: (point: TrendPoint) => number): string =>
      source
        .map((point, index) => {
          const x = 44 + (index / Math.max(source.length - 1, 1)) * 840;
          const y = 270 - (Math.max(0, Math.min(250, pick(point))) / 250) * 248;
          return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');
    const average = make(points, (point) => point.average);
    return {
      average,
      comparison: make(this.comparisonPoints(), (point) => point.average),
      target: make(points, (point) => point.target),
      model: make(points, (point) => point.modelTarget),
      t1: make(points, (point) => point.t1),
      t2: make(points, (point) => point.t2),
      t3: make(points, (point) => point.t3),
      area: average.length === 0 ? '' : `${average} L884 270 L44 270 Z`,
    };
  });
}
