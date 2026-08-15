import { describe, expect, it } from 'vitest';

import { parseCommandCatalog } from './catalog';

describe('command catalog validation', () => {
  it('accepts bounded command entries', () => {
    expect(
      parseCommandCatalog([
        {
          code: 'm104',
          description: 'Set target',
          parameters: [{ name: 'S', description: 'Temperature' }],
        },
      ]),
    ).toEqual([
      {
        code: 'M104',
        description: 'Set target',
        parameters: [{ name: 'S', description: 'Temperature' }],
      },
    ]);
  });

  it('rejects malformed entries', () => {
    expect(parseCommandCatalog([{ code: '<script>', description: 'bad' }])).toBeNull();
    expect(parseCommandCatalog({ entries: [] })).toBeNull();
  });
});
