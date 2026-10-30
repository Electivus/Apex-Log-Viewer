/**
 * The user-facing source definition: what a mapping says, how it is parsed, and where it lives.
 *
 * One definition type serves both the `sfdx-project.json` mapping and the built-in presets
 * (`presets.ts`), so the zero-config path and the configured path run the same resolver and
 * the same query builders.
 *
 * Location: `sfdx-project.json` → `plugins.electivus.customLogs`. Salesforce reserves
 * `plugins` for "Salesforce CLI plugin configurations used with this project": the root schema
 * and the zod validator of `@salesforce/core` are strict at the root and free-form under
 * `plugins`. Core reads the file itself instead of calling `SfProject.getPluginConfiguration`,
 * because `SfProject` is memoized per path for the process lifetime and would go stale in the
 * long-lived extension host, and because that method throws when the section is absent, where
 * absent must mean "built-ins only".
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  CUSTOM_LOG_CONFIG_ISSUE_SEVERITY,
  CUSTOM_LOG_LEVELS,
  type CustomLogConfigIssue,
  type CustomLogLevel
} from './contracts.js';
import { shortHash } from './hash.js';

// ---------------------------------------------------------------------------------------------
// Roles: the single list of semantic fields. The parser's allowed keys, the resolver's
// required/type checks, and the JSON schema test (`schemas/sfdx-project.electivus.schema.json`
// must list exactly these keys) all derive from these two tables.

/** Describe `type` values a role accepts. */
export type RoleSpec = { required: boolean; types: readonly DescribeFieldType[] };

export type DescribeFieldType =
  | 'id'
  | 'string'
  | 'textarea'
  | 'picklist'
  | 'reference'
  | 'datetime'
  | 'date'
  | 'double'
  | 'int'
  | 'boolean'
  | 'url'
  | 'email';

const TEXT = ['string', 'textarea', 'picklist', 'email', 'url', 'id', 'reference'] as const;
const NUMBER = ['double', 'int'] as const;
/** Types a `payload` or `details` field accepts. */
export const LONG_TEXT_TYPES = ['string', 'textarea'] as const satisfies readonly DescribeFieldType[];
/** Types a detail's `presence` and `truncated` flags accept. */
export const FLAG_TYPES = ['boolean'] as const satisfies readonly DescribeFieldType[];

export const TRANSACTION_ROLES = {
  /** Display time and, when filterable, the since/until field. Lists are ordered by CreatedDate. */
  startTime: { required: true, types: ['datetime', ...NUMBER] },
  name: { required: false, types: TEXT },
  user: { required: false, types: TEXT },
  transactionId: { required: false, types: TEXT },
  requestId: { required: false, types: TEXT },
  entryCount: { required: false, types: NUMBER },
  errorCount: { required: false, types: NUMBER },
  warningCount: { required: false, types: NUMBER },
  /** Apex `LoggingLevel.ordinal()` scale: FINEST 2 … ERROR 8. */
  maxLevelOrdinal: { required: false, types: NUMBER }
} as const satisfies Record<string, RoleSpec>;

export const ENTRY_ROLES = {
  /** DateTime, or a number of epoch milliseconds (Nebula's `EpochTimestamp__c`). */
  time: { required: true, types: ['datetime', ...NUMBER] },
  message: { required: true, types: LONG_TEXT_TYPES },
  /** The framework cut the stored message (Nebula `MessageTruncated__c`). */
  messageTruncated: { required: false, types: FLAG_TYPES },
  /** Sequence inside the transaction. Absent: order by time, then Id. */
  order: { required: false, types: NUMBER },
  level: { required: false, types: ['picklist', 'string'] },
  levelOrdinal: { required: false, types: NUMBER },
  origin: { required: false, types: TEXT },
  user: { required: false, types: TEXT },
  /** Groups entries of an `entries` source into one transaction. */
  transactionId: { required: false, types: TEXT },
  requestId: { required: false, types: TEXT },
  exceptionType: { required: false, types: TEXT },
  recordId: { required: false, types: TEXT }
} as const satisfies Record<string, RoleSpec>;

export type TransactionRole = keyof typeof TRANSACTION_ROLES;
export type EntryRole = keyof typeof ENTRY_ROLES;

// ---------------------------------------------------------------------------------------------
// The parsed definition. Field paths are written as in the org, unprefixed for presets.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `^[a-z][a-z0-9-]{0,39}$`. A config source may reuse a built-in id; it then replaces that built-in. */
export type SourceId = Brand<string, 'CustomLogSourceId'>;
/** `Field` or `Relationship.Field` (one hop), `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$`. */
export type FieldPath = Brand<string, 'CustomLogFieldPath'>;
/** An sObject API name, `^[A-Za-z][A-Za-z0-9_]*$`. */
export type ObjectName = Brand<string, 'CustomLogObjectName'>;
/** A flattened payload path (`order.lines[0].sku`), 1..255 characters. Matched exactly, never parsed. */
export type PayloadPath = Brand<string, 'CustomLogPayloadPath'>;

/** One `V` per role of `R`: always present for a required role, optional otherwise. */
export type ByRole<R extends Record<string, RoleSpec>, V> = {
  readonly [K in keyof R as R[K]['required'] extends true ? K : never]: V;
} & {
  readonly [K in keyof R as R[K]['required'] extends true ? never : K]?: V;
};

type RoleMap<R extends Record<string, RoleSpec>> = ByRole<R, FieldPath>;

/**
 * A long field fetched only by `entry`. Written as a bare field path, or as an object that adds
 * the framework's checkbox flags: `presence` (the field has content) and `truncated` (the
 * framework cut it before storing).
 */
export type DetailDefinition = { field: FieldPath; presence?: FieldPath; truncated?: FieldPath };

/**
 * One long-text field holding JSON whose keys become columns. Written as a bare field path, or as
 * an object with the team's default `columns`. Users add more columns in the UI; those stay in
 * the host's workspace state and never reach this file.
 */
export type PayloadDefinition = { field: FieldPath; columns: readonly PayloadPath[] };

export type TransactionDefinition = {
  object: ObjectName;
  fields: RoleMap<typeof TRANSACTION_ROLES>;
  /** Display-only fields, labelled from describe. */
  columns: readonly FieldPath[];
  payload?: PayloadDefinition;
};

export type EntryDefinition = {
  object: ObjectName;
  fields: RoleMap<typeof ENTRY_ROLES>;
  columns: readonly FieldPath[];
  details: readonly DetailDefinition[];
  payload?: PayloadDefinition;
  /** Messages starting with this prefix are the logger's own bookkeeping (`system: true`). */
  systemMessagePrefix?: string;
};

/**
 * Two shapes, discriminated so a header without a parent link, or a parent link without a
 * header, cannot be represented.
 */
export type SourceShapeDefinition =
  | { kind: 'entries'; entry: EntryDefinition }
  | { kind: 'transactions'; transaction: TransactionDefinition; entry: EntryDefinition & { parent: FieldPath } };

export type SourceDefinition = {
  id: SourceId;
  label: string;
  shape: SourceShapeDefinition;
  /** Raw value → canonical level, merged over `DEFAULT_LEVEL_ALIASES`; keys compared case-insensitively. */
  levels: Readonly<Record<string, CustomLogLevel>>;
  /** Hash of this source's normalized definition. Cursors carry it, so a mapping edit invalidates them. */
  digest: string;
};

export type ParsedCustomLogsConfig = {
  projectFile?: string;
  sources: readonly SourceDefinition[];
  issues: readonly CustomLogConfigIssue[];
  /** Hash of the normalized `customLogs` section. Keys the registry's catalog cache. */
  fingerprint: string;
};

export const CONFIG_POINTER = '/plugins/electivus/customLogs';

const CONFIG_KEYS = ['sources'] as const;
const SOURCE_KEYS = ['id', 'label', 'transaction', 'entry', 'levels'] as const;
const TRANSACTION_KEYS = ['object', 'fields', 'columns', 'payload'] as const;
const ENTRY_KEYS = ['object', 'parent', 'fields', 'columns', 'details', 'payload', 'systemMessagePrefix'] as const;
const DETAIL_KEYS = ['field', 'presence', 'truncated'] as const;
const PAYLOAD_KEYS = ['field', 'columns'] as const;

const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const FIELD_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/;
const OBJECT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_NAME_LENGTH = 255;
const MAX_LABEL_LENGTH = 80;

/** Every issue the parser reports goes through here, so its severity is the table's. */
export function configIssue(
  code: CustomLogConfigIssue['code'],
  pointer: string,
  message: string
): CustomLogConfigIssue {
  return { severity: CUSTOM_LOG_CONFIG_ISSUE_SEVERITY[code], pointer, code, message };
}

// ---------------------------------------------------------------------------------------------
// Parsing

type Report = (code: CustomLogConfigIssue['code'], pointer: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeKind(value: unknown): string {
  return Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`;
}

function warnUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  pointer: string,
  report: Report
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      report('unknownKey', `${pointer}/${key}`, `Unknown key "${key}" is ignored. Allowed: ${allowed.join(', ')}.`);
    }
  }
}

function readName<T extends string>(
  value: unknown,
  pattern: RegExp,
  what: string,
  pointer: string,
  report: Report
): T | undefined {
  if (typeof value === 'string' && value.length <= MAX_NAME_LENGTH && pattern.test(value)) return value as T;
  report(
    'invalidValue',
    pointer,
    `${what} must be a valid API name${typeof value === 'string' ? `, got "${value}"` : ''}.`
  );
  return undefined;
}

const readFieldPath = (value: unknown, pointer: string, report: Report) =>
  readName<FieldPath>(value, FIELD_PATH_PATTERN, 'A field', pointer, report);

function readRequired<T>(
  value: Record<string, unknown>,
  key: string,
  pointer: string,
  report: Report,
  read: (value: unknown, pointer: string) => T | undefined
): T | undefined {
  if (value[key] === undefined) {
    report('missingRequired', `${pointer}/${key}`, `"${key}" is required.`);
    return undefined;
  }
  return read(value[key], `${pointer}/${key}`);
}

function readFieldList(value: unknown, pointer: string, report: Report): readonly FieldPath[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report('invalidValue', pointer, `Expected an array of field names, got ${describeKind(value)}.`);
    return undefined;
  }
  const fields = value.map((item, index) => readFieldPath(item, `${pointer}/${index}`, report));
  return fields.every(field => field !== undefined) ? (fields as FieldPath[]) : undefined;
}

function readRoleFields(
  value: unknown,
  roles: Record<string, RoleSpec>,
  pointer: string,
  report: Report
): Record<string, FieldPath> | undefined {
  if (!isRecord(value)) {
    report('notAnObject', pointer, `"fields" must be an object, got ${describeKind(value)}.`);
    return undefined;
  }
  warnUnknownKeys(value, Object.keys(roles), pointer, report);
  const fields: Record<string, FieldPath> = {};
  let valid = true;
  for (const [role, spec] of Object.entries(roles)) {
    if (value[role] === undefined) {
      if (spec.required) {
        report('missingRequired', `${pointer}/${role}`, `The "${role}" role is required.`);
        valid = false;
      }
      continue;
    }
    const field = readFieldPath(value[role], `${pointer}/${role}`, report);
    if (field) fields[role] = field;
    else valid = false;
  }
  return valid ? fields : undefined;
}

function readDetail(value: unknown, pointer: string, report: Report): DetailDefinition | undefined {
  if (typeof value === 'string') {
    const field = readFieldPath(value, pointer, report);
    return field && { field };
  }
  if (!isRecord(value)) {
    report('invalidValue', pointer, `A detail is a field name or an object, got ${describeKind(value)}.`);
    return undefined;
  }
  warnUnknownKeys(value, DETAIL_KEYS, pointer, report);
  const field = readRequired(value, 'field', pointer, report, (item, at) => readFieldPath(item, at, report));
  const flags = (['presence', 'truncated'] as const).map(
    key => [key, value[key] === undefined ? null : readFieldPath(value[key], `${pointer}/${key}`, report)] as const
  );
  if (!field || flags.some(([, flag]) => flag === undefined)) return undefined;
  return { field, ...Object.fromEntries(flags.filter(([, flag]) => flag !== null)) };
}

function readDetails(value: unknown, pointer: string, report: Report): readonly DetailDefinition[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report('invalidValue', pointer, `"details" must be an array, got ${describeKind(value)}.`);
    return undefined;
  }
  const details = value.map((item, index) => readDetail(item, `${pointer}/${index}`, report));
  return details.every(detail => detail !== undefined) ? (details as DetailDefinition[]) : undefined;
}

function readPayloadColumns(value: unknown, pointer: string, report: Report): readonly PayloadPath[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report('invalidValue', pointer, `"columns" must be an array of JSON paths, got ${describeKind(value)}.`);
    return undefined;
  }
  let valid = true;
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.length < 1 || item.length > MAX_NAME_LENGTH) {
      report('invalidValue', `${pointer}/${index}`, 'A payload column is a JSON path of 1 to 255 characters.');
      valid = false;
    }
  }
  return valid ? (value as PayloadPath[]) : undefined;
}

function readPayload(value: unknown, pointer: string, report: Report): PayloadDefinition | undefined {
  if (typeof value === 'string') {
    const field = readFieldPath(value, pointer, report);
    return field && { field, columns: [] };
  }
  if (!isRecord(value)) {
    report('invalidValue', pointer, `"payload" is a field name or an object, got ${describeKind(value)}.`);
    return undefined;
  }
  warnUnknownKeys(value, PAYLOAD_KEYS, pointer, report);
  const field = readRequired(value, 'field', pointer, report, (item, at) => readFieldPath(item, at, report));
  const columns = readPayloadColumns(value.columns, `${pointer}/columns`, report);
  return field && columns && { field, columns };
}

/** Shared by header and entry objects: `payload`, `columns` and the `object` name, each read independently. */
function readObjectParts(value: Record<string, unknown>, pointer: string, report: Report) {
  return {
    object: readRequired(value, 'object', pointer, report, (item, at) =>
      readName<ObjectName>(item, OBJECT_NAME_PATTERN, 'An object', at, report)
    ),
    columns: readFieldList(value.columns, `${pointer}/columns`, report),
    payload: value.payload === undefined ? null : readPayload(value.payload, `${pointer}/payload`, report)
  };
}

function readTransaction(value: unknown, pointer: string, report: Report): TransactionDefinition | undefined {
  if (!isRecord(value)) {
    report('notAnObject', pointer, `"transaction" must be an object, got ${describeKind(value)}.`);
    return undefined;
  }
  warnUnknownKeys(value, TRANSACTION_KEYS, pointer, report);
  const { object, columns, payload } = readObjectParts(value, pointer, report);
  const fields = readRequired(value, 'fields', pointer, report, (item, at) =>
    readRoleFields(item, TRANSACTION_ROLES, at, report)
  );
  if (!object || !columns || !fields || payload === undefined) return undefined;
  return {
    object,
    fields: fields as TransactionDefinition['fields'],
    columns,
    ...(payload ? { payload } : {})
  };
}

function readEntry(
  value: unknown,
  pointer: string,
  hasTransaction: boolean,
  report: Report
): (EntryDefinition & { parent?: FieldPath }) | undefined {
  if (!isRecord(value)) {
    report('notAnObject', pointer, `"entry" must be an object, got ${describeKind(value)}.`);
    return undefined;
  }
  warnUnknownKeys(value, ENTRY_KEYS, pointer, report);
  const { object, columns, payload } = readObjectParts(value, pointer, report);
  const fields = readRequired(value, 'fields', pointer, report, (item, at) =>
    readRoleFields(item, ENTRY_ROLES, at, report)
  );
  const details = readDetails(value.details, `${pointer}/details`, report);
  let parent: FieldPath | undefined;
  let parentValid = true;
  if (hasTransaction) {
    parent = readRequired(value, 'parent', pointer, report, (item, at) => readFieldPath(item, at, report));
    parentValid = parent !== undefined;
  } else if (value.parent !== undefined) {
    report(
      'invalidValue',
      `${pointer}/parent`,
      '"parent" links entries to a header, so it needs a "transaction" in this source.'
    );
    parentValid = false;
  }
  let systemMessagePrefix: string | undefined;
  let prefixValid = true;
  if (value.systemMessagePrefix !== undefined) {
    const prefix = value.systemMessagePrefix;
    if (typeof prefix === 'string' && prefix.length >= 1 && prefix.length <= MAX_NAME_LENGTH)
      systemMessagePrefix = prefix;
    else {
      report(
        'invalidValue',
        `${pointer}/systemMessagePrefix`,
        '"systemMessagePrefix" is a string of 1 to 255 characters.'
      );
      prefixValid = false;
    }
  }
  if (!object || !columns || !fields || !details || payload === undefined || !parentValid || !prefixValid)
    return undefined;
  return {
    object,
    fields: fields as EntryDefinition['fields'],
    columns,
    details,
    ...(payload ? { payload } : {}),
    ...(systemMessagePrefix ? { systemMessagePrefix } : {}),
    ...(parent ? { parent } : {})
  };
}

function readLevels(value: unknown, pointer: string, report: Report): Record<string, CustomLogLevel> | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    report('notAnObject', pointer, `"levels" must be an object, got ${describeKind(value)}.`);
    return undefined;
  }
  const levels: Record<string, CustomLogLevel> = {};
  let valid = true;
  for (const [raw, level] of Object.entries(value)) {
    if (typeof level === 'string' && (CUSTOM_LOG_LEVELS as readonly string[]).includes(level)) {
      levels[raw] = level as CustomLogLevel;
    } else {
      report('invalidValue', `${pointer}/${raw}`, `A level maps to one of ${CUSTOM_LOG_LEVELS.join(', ')}.`);
      valid = false;
    }
  }
  return valid ? levels : undefined;
}

/**
 * Parse one source object. Used by `parseCustomLogsConfig` for each `sources[i]` and by
 * `presets.ts` for built-ins. `definition` is undefined when any `error` issue was found.
 */
export function parseSourceDefinition(
  raw: unknown,
  pointer: string
): { definition?: SourceDefinition; issues: CustomLogConfigIssue[] } {
  const issues: CustomLogConfigIssue[] = [];
  const report: Report = (code, at, message) => issues.push(configIssue(code, at, message));
  if (!isRecord(raw)) {
    report('notAnObject', pointer, `A source must be an object, got ${describeKind(raw)}.`);
    return { issues };
  }
  warnUnknownKeys(raw, SOURCE_KEYS, pointer, report);

  const id = readRequired(raw, 'id', pointer, report, (value, at) => {
    if (typeof value === 'string' && SOURCE_ID_PATTERN.test(value)) return value as SourceId;
    report(
      'invalidValue',
      at,
      'A source id is lower-case letters, digits and hyphens, starting with a letter (40 characters at most).'
    );
    return undefined;
  });
  let label: string | undefined = id;
  let labelValid = true;
  if (raw.label !== undefined) {
    if (typeof raw.label === 'string' && raw.label.length <= MAX_LABEL_LENGTH) label = raw.label || label;
    else {
      report('invalidValue', `${pointer}/label`, `"label" is a string of ${MAX_LABEL_LENGTH} characters at most.`);
      labelValid = false;
    }
  }
  const hasTransaction = raw.transaction !== undefined;
  const transaction = hasTransaction ? readTransaction(raw.transaction, `${pointer}/transaction`, report) : undefined;
  const entry = readRequired(raw, 'entry', pointer, report, (value, at) =>
    readEntry(value, at, hasTransaction, report)
  );
  const levels = readLevels(raw.levels, `${pointer}/levels`, report);

  if (issues.some(issue => issue.severity === 'error') || !id || !label || !labelValid || !entry || !levels) {
    return { issues };
  }
  const { parent, ...entryDefinition } = entry;
  const shape: SourceShapeDefinition =
    transaction && parent
      ? { kind: 'transactions', transaction, entry: { ...entryDefinition, parent } }
      : { kind: 'entries', entry: entryDefinition };
  const definition = { id, label, shape, levels };
  return { definition: { ...definition, digest: shortHash({ id, shape, levels }) }, issues };
}

/**
 * Parse `plugins.electivus.customLogs` (any JSON value) into definitions plus issues.
 *
 * - Pure. Never throws on user input.
 * - Each source parses independently: a source with any `error` issue is skipped; every other
 *   source still loads, and so do the built-ins.
 * - Unknown keys at any level yield `unknownKey` warnings and are ignored. The JSON schema
 *   accepts them too, so the editor and the parser give the same verdict.
 * - `id` is unique within the file; a later duplicate is skipped. Reusing a built-in id is
 *   allowed and replaces that built-in.
 */
export function parseCustomLogsConfig(raw: unknown): { sources: SourceDefinition[]; issues: CustomLogConfigIssue[] } {
  if (raw === undefined) return { sources: [], issues: [] };
  const issues: CustomLogConfigIssue[] = [];
  const report: Report = (code, at, message) => issues.push(configIssue(code, at, message));
  if (!isRecord(raw)) {
    report('notAnObject', CONFIG_POINTER, `"customLogs" must be an object, got ${describeKind(raw)}.`);
    return { sources: [], issues };
  }
  warnUnknownKeys(raw, CONFIG_KEYS, CONFIG_POINTER, report);
  if (raw.sources === undefined) return { sources: [], issues };
  if (!Array.isArray(raw.sources)) {
    report(
      'invalidValue',
      `${CONFIG_POINTER}/sources`,
      `"sources" must be an array, got ${describeKind(raw.sources)}.`
    );
    return { sources: [], issues };
  }

  const sources: SourceDefinition[] = [];
  const firstPointerById = new Map<string, string>();
  for (const [index, value] of raw.sources.entries()) {
    const pointer = `${CONFIG_POINTER}/sources/${index}`;
    const parsed = parseSourceDefinition(value, pointer);
    issues.push(...parsed.issues);
    const { definition } = parsed;
    if (!definition) continue;
    const first = firstPointerById.get(definition.id);
    if (first) {
      report('duplicateId', `${pointer}/id`, `Source id "${definition.id}" is already defined at ${first}.`);
      continue;
    }
    firstPointerById.set(definition.id, pointer);
    sources.push(definition);
  }
  return { sources, issues };
}

// ---------------------------------------------------------------------------------------------
// Loading

const PROJECT_FILE = 'sfdx-project.json';

async function findProjectFile(projectDir: string): Promise<{ file: string; text: string } | undefined> {
  for (let dir = path.resolve(projectDir); ; dir = path.dirname(dir)) {
    const file = path.join(dir, PROJECT_FILE);
    try {
      return { file, text: await fs.readFile(file, 'utf8') };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EISDIR') throw error;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * Find `sfdx-project.json` at or above `projectDir`, read it fresh, and parse its
 * `plugins.electivus.customLogs`. No project, or `projectDir` undefined: empty config.
 * Unreadable or invalid JSON: one `invalidJson` error issue, empty sources (built-ins still
 * resolve). Never throws for file content; rethrows only unexpected fs errors (EACCES).
 */
export async function loadCustomLogsConfig(projectDir: string | undefined): Promise<ParsedCustomLogsConfig> {
  const found = projectDir === undefined ? undefined : await findProjectFile(projectDir);
  if (!found) return { sources: [], issues: [], fingerprint: shortHash(null) };

  let project: unknown;
  try {
    project = JSON.parse(found.text);
  } catch (error) {
    const issue = configIssue('invalidJson', '', `${PROJECT_FILE} is not valid JSON: ${(error as Error).message}`);
    return { projectFile: found.file, sources: [], issues: [issue], fingerprint: shortHash(null) };
  }
  const plugins = isRecord(project) ? project.plugins : undefined;
  const electivus = isRecord(plugins) ? plugins.electivus : undefined;
  const section = isRecord(electivus) ? electivus.customLogs : undefined;
  return { projectFile: found.file, ...parseCustomLogsConfig(section), fingerprint: shortHash(section ?? null) };
}
