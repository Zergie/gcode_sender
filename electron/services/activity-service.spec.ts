import { describe, expect, it } from 'vitest';

import { ActivityService } from './activity-service';

describe('ActivityService', () => {
  it('keeps each supported activity exclusive until its owner releases', () => {
    const activities = ['job', 'tuning', 'validation'] as const;

    for (const owner of activities) {
      const service = new ActivityService();

      expect(service.acquire(owner)).toEqual({ active: owner });
      expect(service.getState()).toEqual({ active: owner });

      for (const requested of activities) {
        expect(() => service.acquire(requested)).toThrowError(
          expect.objectContaining({
            code: 'BUSY',
            recoverable: true,
            details: { active: owner, requested },
          }),
        );
        expect(service.getState()).toEqual({ active: owner });
      }

      expect(service.release(owner)).toEqual({ active: null });
      expect(service.acquire(owner)).toEqual({ active: owner });
    }
  });
});
