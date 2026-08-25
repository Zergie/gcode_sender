import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { HeatingProfile } from '../../../shared/contracts';
import type { TrendPoint } from '../core/platform/workbench.store';

export interface ProfilePointEdit {
  readonly index: number;
  readonly timeMs: number;
  readonly targetC: number;
}

interface ProfileNodeGeometry extends ProfilePointEdit {
  readonly x: number;
  readonly y: number;
}

interface ChartGeometry {
  readonly average: string;
  readonly comparison: string;
  readonly target: string;
  readonly model: string;
  readonly t1: string;
  readonly t2: string;
  readonly t3: string;
  readonly area: string;
  readonly profile: string;
  readonly profileNodes: readonly ProfileNodeGeometry[];
  readonly playheadX: number | null;
}

@Component({
  selector: 'app-trend-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="trend-wrap"
      [class.profile-editable]="profileEditable()"
      role="group"
      [attr.aria-label]="
        profile() === null ? 'Temperature history chart' : 'Temperature history and heating profile'
      "
    >
      <svg
        viewBox="0 0 900 300"
        preserveAspectRatio="none"
        (pointermove)="onPointerMove($event)"
        (pointerup)="endPointerEdit()"
        (pointercancel)="endPointerEdit()"
      >
        <defs>
          <linearGradient id="temperature-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--accent)" stop-opacity=".2" />
            <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        <g class="grid-lines" aria-hidden="true">
          <path d="M44 22H884M44 71.6H884M44 121.2H884M44 170.8H884M44 220.4H884M44 270H884" />
          <path d="M44 22V270M254 22V270M464 22V270M674 22V270M884 22V270" />
        </g>
        <path class="area" [attr.d]="geometry().area" aria-hidden="true" />
        <path class="series t1" [attr.d]="geometry().t1" aria-hidden="true" />
        <path class="series t2" [attr.d]="geometry().t2" aria-hidden="true" />
        <path class="series t3" [attr.d]="geometry().t3" aria-hidden="true" />
        <path class="series requested" [attr.d]="geometry().target" aria-hidden="true" />
        @if (showModelTarget()) {
          <path class="series model" [attr.d]="geometry().model" aria-hidden="true" />
        }
        <path class="series comparison" [attr.d]="geometry().comparison" aria-hidden="true" />
        <path class="series average" [attr.d]="geometry().average" aria-hidden="true" />
        @if (profile() !== null) {
          <path class="series profile" [attr.d]="geometry().profile" aria-hidden="true" />
          @if (geometry().playheadX; as playheadX) {
            <g class="profile-playhead" aria-hidden="true">
              <path [attr.d]="'M' + playheadX + ' 22V270'" />
              <circle [attr.cx]="playheadX" cy="22" r="4" />
            </g>
          }
          @for (node of geometry().profileNodes; track node.index) {
            <g class="profile-node" [class.selected]="selectedProfilePoint() === node.index">
              <circle class="profile-node-visible" [attr.cx]="node.x" [attr.cy]="node.y" r="5" />
              <circle
                class="profile-node-hit"
                [attr.cx]="node.x"
                [attr.cy]="node.y"
                r="15"
                [attr.tabindex]="profileEditable() ? 0 : -1"
                role="slider"
                aria-roledescription="heating profile stage"
                aria-valuemin="0"
                aria-valuemax="250"
                [attr.aria-valuenow]="node.targetC"
                [attr.aria-valuetext]="profilePointLabel(node)"
                [attr.aria-label]="'Stage ' + (node.index + 1)"
                (focus)="profilePointSelected.emit(node.index)"
                (pointerdown)="beginPointerEdit($event, node.index)"
                (keydown)="onProfilePointKeydown($event, node)"
              />
            </g>
          }
        }
        <g class="axis-labels" aria-hidden="true">
          <text x="5" y="27">250°</text>
          <text x="12" y="76.6">200°</text>
          <text x="12" y="126.2">150°</text>
          <text x="12" y="175.8">100°</text>
          <text x="20" y="225.4">50°</text>
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
    .trend-wrap.profile-editable svg {
      touch-action: none;
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
    .series.profile {
      stroke: #20c7c7;
      stroke-width: 3;
      filter: drop-shadow(0 0 4px color-mix(in srgb, #20c7c7 38%, transparent));
    }
    .profile-node-visible {
      fill: var(--surface);
      stroke: #20c7c7;
      stroke-width: 2.5;
      vector-effect: non-scaling-stroke;
      pointer-events: none;
    }
    .profile-node.selected .profile-node-visible {
      fill: #20c7c7;
      stroke: var(--text);
    }
    .profile-node-hit {
      fill: transparent;
      stroke: transparent;
      cursor: grab;
      vector-effect: non-scaling-stroke;
    }
    .profile-node-hit:focus-visible {
      stroke: var(--text);
      stroke-width: 2;
    }
    .profile-editable .profile-node-hit:active {
      cursor: grabbing;
    }
    .profile-playhead path {
      stroke: #20c7c7;
      stroke-width: 1.5;
      stroke-dasharray: 4 4;
      vector-effect: non-scaling-stroke;
    }
    .profile-playhead circle {
      fill: #20c7c7;
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
  readonly windowStart = input<number | null>(null);
  readonly windowEnd = input<number | null>(null);
  readonly showModelTarget = input(true);
  readonly profile = input<HeatingProfile | null>(null);
  readonly profileAnchor = input<number | null>(null);
  readonly profileEditable = input(false);
  readonly selectedProfilePoint = input(0);
  readonly profilePlayheadMs = input<number | null>(null);
  readonly profilePointChanged = output<ProfilePointEdit>();
  readonly profilePointSelected = output<number>();
  readonly profilePointDeleted = output<number>();
  private draggingPoint: number | null = null;

  readonly geometry = computed<ChartGeometry>(() => {
    const points = this.points();
    const comparisonPoints = this.comparisonPoints();
    const profile = this.profile();
    const profileAnchor = this.profileAnchor() ?? 0;
    const profileTimes = profile?.points.map((point) => profileAnchor + point.timeMs) ?? [];
    const allTimes = [
      ...points.map((point) => point.time),
      ...comparisonPoints.map((point) => point.time),
      ...profileTimes,
    ];
    const requestedStart = this.windowStart();
    const requestedEnd = this.windowEnd();
    const start = requestedStart ?? (allTimes.length === 0 ? 0 : Math.min(...allTimes));
    const end = requestedEnd ?? (allTimes.length === 0 ? 1 : Math.max(...allTimes));
    const duration = Math.max(end - start, 1);
    const xForTime = (time: number): number =>
      44 + Math.max(0, Math.min(1, (time - start) / duration)) * 840;
    const yForTemperature = (temperature: number): number =>
      270 - (Math.max(0, Math.min(250, temperature)) / 250) * 248;
    const make = (source: readonly TrendPoint[], pick: (point: TrendPoint) => number): string =>
      source
        .map((point, index) => {
          const x = xForTime(point.time);
          const y = yForTemperature(pick(point));
          return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');
    const average = make(points, (point) => point.average);
    const firstPoint = points.at(0);
    const lastPoint = points.at(-1);
    const firstX = firstPoint === undefined ? 44 : xForTime(firstPoint.time);
    const lastX = lastPoint === undefined ? 884 : xForTime(lastPoint.time);
    const profileNodes =
      profile?.points.map((point, index) => ({
        index,
        timeMs: point.timeMs,
        targetC: point.targetC,
        x: xForTime(profileAnchor + point.timeMs),
        y: yForTemperature(point.targetC),
      })) ?? [];
    const profilePath = profileNodes
      .map((node, index) => `${index === 0 ? 'M' : 'L'}${node.x.toFixed(1)} ${node.y.toFixed(1)}`)
      .join(' ');
    const playhead = this.profilePlayheadMs();
    return {
      average,
      comparison: make(comparisonPoints, (point) => point.average),
      target: make(points, (point) => point.target),
      model: make(points, (point) => point.modelTarget),
      t1: make(points, (point) => point.t1),
      t2: make(points, (point) => point.t2),
      t3: make(points, (point) => point.t3),
      area:
        average.length === 0
          ? ''
          : `${average} L${lastX.toFixed(1)} 270 L${firstX.toFixed(1)} 270 Z`,
      profile: profilePath,
      profileNodes,
      playheadX: playhead === null ? null : xForTime(profileAnchor + playhead),
    };
  });

  beginPointerEdit(event: PointerEvent, index: number): void {
    if (!this.profileEditable()) return;
    event.preventDefault();
    this.draggingPoint = index;
    this.profilePointSelected.emit(index);
    const target = event.currentTarget as SVGCircleElement;
    target.focus();
    target.setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (this.draggingPoint === null || !this.profileEditable()) return;
    const svg = event.currentTarget as SVGSVGElement;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * 900;
    const y = ((event.clientY - bounds.top) / bounds.height) * 300;
    const profile = this.profile();
    const duration = profile?.points.at(-1)?.timeMs ?? 1;
    this.profilePointChanged.emit({
      index: this.draggingPoint,
      timeMs: Math.round(Math.max(0, Math.min(1, (x - 44) / 840)) * duration),
      targetC: Math.round(Math.max(0, Math.min(250, ((270 - y) / 248) * 250))),
    });
  }

  endPointerEdit(): void {
    this.draggingPoint = null;
  }

  onProfilePointKeydown(event: KeyboardEvent, point: ProfilePointEdit): void {
    if (!this.profileEditable()) return;
    const large = event.shiftKey;
    let edit: ProfilePointEdit | null = null;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const delta = (large ? 5 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
      edit = {
        index: point.index,
        timeMs: point.timeMs,
        targetC: point.targetC + delta,
      };
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && point.index > 0) {
      const delta = (large ? 10_000 : 1_000) * (event.key === 'ArrowRight' ? 1 : -1);
      edit = {
        index: point.index,
        timeMs: point.timeMs + delta,
        targetC: point.targetC,
      };
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && point.index > 0) {
      event.preventDefault();
      this.profilePointDeleted.emit(point.index);
      return;
    }
    if (edit !== null) {
      event.preventDefault();
      this.profilePointChanged.emit(edit);
    }
  }

  profilePointLabel(point: ProfilePointEdit): string {
    const seconds = Math.round(point.timeMs / 1_000);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${point.targetC} degrees at ${minutes} minutes ${remainder} seconds`;
  }
}
