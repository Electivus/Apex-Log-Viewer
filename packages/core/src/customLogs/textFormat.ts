/**
 * The one JSON-or-text rule for long text: it decides a payload's state, a long value's `format`,
 * and the editor language the extension opens a value in. Pure and dependency-free, so the
 * contracts entry point can export it.
 */

import type { CustomLogTextFormat } from './contracts.js';

/** The first non-blank character opens an object or an array. */
export function startsLikeJson(text: string): boolean {
  const first = text.trimStart()[0];
  return first === '{' || first === '[';
}

/** The parsed object or array, or undefined when `text` is not JSON or is a JSON scalar. */
export function parseJsonContainer(text: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `json` when `text` is one JSON object or array, blank around it allowed; otherwise `text`. */
export function customLogTextFormat(text: string): CustomLogTextFormat {
  return startsLikeJson(text) && parseJsonContainer(text) ? 'json' : 'text';
}
