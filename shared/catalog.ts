import type { CommandCatalogEntry, CommandParameter } from './contracts';

export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const MAX_CATALOG_ENTRIES = 10_000;

export function parseCommandCatalog(value: unknown): readonly CommandCatalogEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_CATALOG_ENTRIES) {
    return null;
  }

  const entries: CommandCatalogEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return null;
    }

    const code = readBoundedString(item['code'], 1, 32);
    const description = readBoundedString(item['description'], 0, 2_000);
    if (code === null || description === null || !/^[GMTD]\d+(?:\.\d+)?$/i.test(code)) {
      return null;
    }

    let parameters: CommandParameter[] | undefined;
    if (item['parameters'] !== undefined) {
      if (!Array.isArray(item['parameters']) || item['parameters'].length > 100) {
        return null;
      }
      parameters = [];
      for (const parameter of item['parameters']) {
        if (!isRecord(parameter)) {
          return null;
        }
        const name = readBoundedString(parameter['name'], 1, 64);
        const parameterDescription = readBoundedString(parameter['description'], 0, 2_000);
        if (name === null || parameterDescription === null) {
          return null;
        }
        parameters.push({ name, description: parameterDescription });
      }
    }

    entries.push({
      code: code.toUpperCase(),
      description,
      ...(parameters === undefined ? {} : { parameters }),
    });
  }

  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoundedString(value: unknown, minimum: number, maximum: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length < minimum || trimmed.length > maximum ? null : trimmed;
}
