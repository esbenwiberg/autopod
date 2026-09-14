import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type LaunchRequest,
  type SeriesLaunchRequest,
  configurationIdSchema,
  launchRequestSchema,
  seriesLaunchRequestSchema,
} from '@autopod/shared';
import { getConfigDir } from './config-store.js';

/** Persist the exact admission request before sending it, so a lost reply can be retried safely. */
export function saveLaunchReceipt(
  request: LaunchRequest,
  directory = join(getConfigDir(), 'launches'),
): string {
  return saveRequest(request, launchRequestSchema.parse, directory);
}
export function saveSeriesReceipt(
  request: SeriesLaunchRequest,
  directory = join(getConfigDir(), 'series-launches'),
): string {
  return saveRequest(request, seriesLaunchRequestSchema.parse, directory);
}
function saveRequest<T extends { requestId?: string }>(
  request: T,
  parse: (value: unknown) => unknown,
  directory: string,
): string {
  const id = configurationIdSchema.parse(request.requestId);
  const parsed = parse(request);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.json`);
  let descriptor: number;
  try {
    descriptor = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!isDeepStrictEqual(parse(JSON.parse(readFileSync(path, 'utf8'))), parsed)) {
      throw new Error(
        `Launch key ${id} already belongs to a different request. Select a new request ID.`,
      );
    }
    return path;
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(parsed, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}
