import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { HeatingProfile } from '../shared/contracts';
import { serializeHeatingProfileDocument } from '../shared/heating-profile-document';

export function heatingProfileDefaultFileName(name: string): string {
  const sanitized = Array.from(
    Array.from(name.trim())
      .map((character) =>
        '<>:"/\\|?*'.includes(character) || character.charCodeAt(0) < 32 ? '-' : character,
      )
      .join('')
      .replace(/[. ]+$/g, ''),
  )
    .slice(0, 100)
    .join('');
  const baseName = sanitized.length === 0 ? 'heating-profile' : sanitized;
  const windowsSafeName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(baseName)
    ? `profile-${baseName}`
    : baseName;
  return `${windowsSafeName}.gcode`;
}

export function forceGcodeExtension(filePath: string): string {
  const selectedExtension = path.extname(filePath);
  return selectedExtension === '.gcode'
    ? filePath
    : `${filePath.slice(0, filePath.length - selectedExtension.length)}.gcode`;
}

export async function writeHeatingProfileFile(
  selectedPath: string,
  profile: HeatingProfile,
): Promise<string> {
  const destination = forceGcodeExtension(selectedPath);
  const temporaryPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, serializeHeatingProfileDocument(profile), {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return destination;
}
