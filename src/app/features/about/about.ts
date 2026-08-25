import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { WorkbenchStore } from '../../core/platform/workbench.store';
import { IconComponent } from '../../shared/icon';
import { PageHeaderComponent } from '../../shared/page-header';

@Component({
  selector: 'app-about',
  imports: [IconComponent, PageHeaderComponent],
  templateUrl: './about.html',
  styleUrl: './about.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutComponent {
  readonly store = inject(WorkbenchStore);
}
