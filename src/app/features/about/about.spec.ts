import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

@Component({
  selector: 'app-first-style-fixture',
  template: '<div class="same-local-name">first</div>',
  styles: '.same-local-name { color: rgb(255, 0, 0); }',
})
class FirstStyleFixture {}

@Component({
  selector: 'app-second-style-fixture',
  template: '<div class="same-local-name">second</div>',
  styles: '.same-local-name { color: rgb(0, 0, 255); }',
})
class SecondStyleFixture {}

describe('About route style migration seam', () => {
  it('keeps matching local class names isolated between components', async () => {
    await TestBed.configureTestingModule({
      imports: [FirstStyleFixture, SecondStyleFixture],
    }).compileComponents();

    const first = TestBed.createComponent(FirstStyleFixture);
    const second = TestBed.createComponent(SecondStyleFixture);
    first.detectChanges();
    second.detectChanges();

    expect(getComputedStyle(first.nativeElement.querySelector('.same-local-name')).color).toBe(
      'rgb(255, 0, 0)',
    );
    expect(getComputedStyle(second.nativeElement.querySelector('.same-local-name')).color).toBe(
      'rgb(0, 0, 255)',
    );
  });
});
