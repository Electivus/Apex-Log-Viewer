import { CUSTOM_LOG_LEVELS } from '@alv/core/contracts';
import { Flags } from '@salesforce/sf-plugins-core';

/**
 * Flags shared by `sf electivus custom-log ...`. Spellings are a public contract: they follow
 * `sf` conventions (`--target-org` comes from `flags.ts`) and never change meaning.
 *
 * No `--project-dir`: like `sf project deploy`, the project is the one containing the current
 * directory. The adapter passes `process.cwd()` as `projectDir`.
 */

export const sourceFlag = Flags.string({
  summary:
    'Log source id from "sf electivus custom-log sources", for example nebula. Optional when one source is ready.'
});

export const minLevelFlag = Flags.option({
  options: CUSTOM_LOG_LEVELS,
  summary: 'Keep logs or entries at or above this level.'
})();

export const cursorFlag = Flags.string({
  summary: 'Continue from the nextCursor value of a previous result.'
});

export const payloadFieldsFlag = Flags.string({
  multiple: true,
  delimiter: ',',
  summary: 'Keep only these JSON payload paths in each row, for example orderId,http.status.'
});
