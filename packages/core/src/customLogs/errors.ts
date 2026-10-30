/**
 * How Custom Logs fails: `customLogError` builds every error it throws, so a code outside the CLI
 * contract cannot ship, and `CANNOT_READ_CODES` names the Salesforce answers that mean this user
 * may not read what was asked.
 */

import { AlvError } from '../errors.js';
import type { CustomLogErrorCode } from './contracts.js';

/** A Custom Logs failure: a code of the CLI contract, or `INVALID_ARGUMENT` for input refused before any query. */
export function customLogError(code: CustomLogErrorCode | 'INVALID_ARGUMENT', message: string): AlvError {
  return new AlvError(code, message);
}

/** Salesforce error codes for a query this user may not run: the API, or the object, is closed to them. */
export const CANNOT_READ_CODES: ReadonlySet<string> = new Set([
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'API_DISABLED_FOR_ORG',
  'API_CURRENTLY_DISABLED',
  'FORBIDDEN'
]);
