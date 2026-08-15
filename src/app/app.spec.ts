import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('renders the required navigation order', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const labels = [...compiled.querySelectorAll('.nav-item .nav-label')].map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Dashboard',
      'Terminal',
      'Jobs',
      'Simulation',
      'Tuning & Profiles',
      'Settings',
      'About',
    ]);
  });

  it('can expand the sidebar again after it was collapsed', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    app.collapsed.set(true);
    document.documentElement.dataset['sidebar'] = 'collapsed';

    app.collapseSidebar();

    expect(app.collapsed()).toBe(false);
    expect(document.documentElement.dataset['sidebar']).toBe('expanded');
    fixture.destroy();
  });
});
