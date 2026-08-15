import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-header">
      <div>
        <div class="eyebrow">{{ eyebrow() }}</div>
        <h1>{{ title() }}</h1>
        <p>{{ description() }}</p>
      </div>
      <div class="page-actions"><ng-content /></div>
    </header>
  `,
})
export class PageHeaderComponent {
  readonly eyebrow = input('THERMAL WORKBENCH');
  readonly title = input.required<string>();
  readonly description = input.required<string>();
}
