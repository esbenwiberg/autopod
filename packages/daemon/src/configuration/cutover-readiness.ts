import type Database from 'better-sqlite3';
import { readConfigurationCutover } from './configuration-cutover.js';

/** The release switch is source-controlled. A conversion receipt cannot enable unfinished code. */
export function configurationCutoverReadiness(
  db: Database.Database,
  releaseAccepted: boolean,
): { ready: boolean; reason?: string } {
  if (!releaseAccepted)
    return {
      ready: false,
      reason: 'Composable launch implementation and acceptance are incomplete',
    };
  try {
    if (!readConfigurationCutover(db))
      return {
        ready: false,
        reason: 'Review and apply the configuration cutover before admitting pods',
      };
  } catch {
    return {
      ready: false,
      reason: 'Configuration cutover receipt is invalid; reconcile it before admitting pods',
    };
  }
  return { ready: true };
}
