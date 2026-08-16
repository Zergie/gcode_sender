import { TestBed } from '@angular/core/testing';
import { TrendChartComponent, type ProfilePointEdit } from './trend-chart';

describe('TrendChartComponent heating profile overlay', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TrendChartComponent] }).compileComponents();
  });

  it('emits accessible keyboard edits for a focused profile stage', () => {
    const fixture = TestBed.createComponent(TrendChartComponent);
    fixture.componentRef.setInput('points', []);
    fixture.componentRef.setInput('windowStart', 1_000);
    fixture.componentRef.setInput('windowEnd', 61_000);
    fixture.componentRef.setInput('profileAnchor', 1_000);
    fixture.componentRef.setInput('profileEditable', true);
    fixture.componentRef.setInput('profile', {
      version: 1,
      name: 'Keyboard profile',
      interpolation: 'linear',
      points: [
        { timeMs: 0, targetC: 20 },
        { timeMs: 60_000, targetC: 180 },
      ],
    });
    const edits: ProfilePointEdit[] = [];
    fixture.componentInstance.profilePointChanged.subscribe((edit) => edits.push(edit));
    fixture.detectChanges();

    const second = fixture.nativeElement.querySelectorAll(
      '.profile-node-hit',
    )[1] as SVGCircleElement;
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

    expect(second.getAttribute('role')).toBe('slider');
    expect(second.getAttribute('aria-valuetext')).toContain('180 degrees');
    expect(edits).toEqual([{ index: 1, timeMs: 60_000, targetC: 181 }]);
  });

  it('never emits a horizontal time edit for the fixed first stage', () => {
    const fixture = TestBed.createComponent(TrendChartComponent);
    fixture.componentRef.setInput('points', []);
    fixture.componentRef.setInput('profileEditable', true);
    fixture.componentRef.setInput('profile', {
      version: 1,
      name: 'Fixed start',
      interpolation: 'linear',
      points: [
        { timeMs: 0, targetC: 20 },
        { timeMs: 60_000, targetC: 180 },
      ],
    });
    const edits: ProfilePointEdit[] = [];
    fixture.componentInstance.profilePointChanged.subscribe((edit) => edits.push(edit));
    fixture.detectChanges();

    const first = fixture.nativeElement.querySelector('.profile-node-hit') as SVGCircleElement;
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(edits).toEqual([]);
  });
});
