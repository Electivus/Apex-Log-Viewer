/**
 * The resolved model: a definition checked against this org and this user. A `ready`
 * `CatalogEntry` carries a `ResolvedSource` whose every field is known to exist, to be readable
 * by the running user, and to have a compatible type. Query builders take only `ResolvedRecordSource`,
 * so a SELECT can only name readable fields (the `LoggerEndUser` FLS gap cannot reach a query)
 * and a filter can only use a capability the source has. Internal; never crosses the package
 * boundary.
 */

import type { ByRole, DescribeFieldType, ENTRY_ROLES, PayloadPath, SourceId, TRANSACTION_ROLES } from './config.js';
import type {
  CustomLogSourceObjects,
  CustomLogSourceOrigin,
  CustomLogSourceShape,
  CustomLogSourceState
} from './contracts.js';
import type { LevelTable } from './levels.js';

/** A field confirmed by describe. `api` is the qualified path to put in SOQL. */
export type ResolvedField = {
  /** As written in the definition, unprefixed. Stable across namespaces; used as DTO key. */
  readonly key: string;
  readonly api: string;
  readonly label: string;
  readonly type: DescribeFieldType;
  readonly sortable: boolean;
  readonly filterable: boolean;
};

/** Time is read as ISO either way; the builder needs to know how to write literals. */
export type ResolvedTimeField = ResolvedField & { readonly encoding: 'datetime' | 'epochMillis' };

/** `CreatedDate`: never null, always sortable and filterable. The list keyset and the time fallback. */
export const CREATED_DATE: ResolvedTimeField = {
  key: 'CreatedDate',
  api: 'CreatedDate',
  label: 'Created Date',
  type: 'datetime',
  sortable: true,
  filterable: true,
  encoding: 'datetime'
};

/** `field` when SOQL can filter on it. A role on a field that cannot be filtered is shown, never filtered on. */
export function filterableField(field: ResolvedField | undefined): ResolvedField | undefined {
  return field?.filterable ? field : undefined;
}

/** A level filter on a field of the object itself. */
export type FieldLevelPredicate =
  | { readonly kind: 'ordinal'; readonly field: ResolvedField } // field >= APEX_LEVEL_ORDINALS[min]
  | { readonly kind: 'values'; readonly field: ResolvedField }; // field IN table.rawAtOrAbove[min]

/** How a minimum-level filter on entries becomes SOQL. Computed once; builders switch on `kind`. */
export type EntryLevelPredicate = FieldLevelPredicate | { readonly kind: 'none' };

/** How a minimum-level filter on headers becomes SOQL: their own ordinal, or the levels of their entries. */
export type HeaderLevelPredicate =
  | { readonly kind: 'ordinal'; readonly field: ResolvedField }
  | {
      readonly kind: 'semiJoin'; // Id IN (SELECT parent FROM entryObject WHERE <entry>)
      readonly entryObject: string;
      readonly parent: ResolvedField;
      readonly entry: FieldLevelPredicate;
    }
  | { readonly kind: 'none' };

/** A mapped long field. Hidden ones stay listed so `entry` can answer `hidden` instead of dropping them. */
export type ResolvedLongField =
  | { readonly state: 'readable'; readonly key: string; readonly field: ResolvedField }
  | { readonly state: 'hidden'; readonly key: string; readonly label: string };

/** A detail with its flags. A flag is kept even when the text is hidden: `LoggerEndUser` reads `HasStackTrace__c`, not `StackTrace__c`. */
export type ResolvedDetail = ResolvedLongField & {
  readonly presence?: ResolvedField;
  readonly truncated?: ResolvedField;
};

export type ResolvedPayload = ResolvedLongField & { readonly columns: readonly PayloadPath[] };

/** Every mapped role describe returned. Required roles are always there; a hidden optional role is absent. */
export type ResolvedEntryRoles = ByRole<typeof ENTRY_ROLES, ResolvedField> & { readonly time: ResolvedTimeField };

export type ResolvedTransactionRoles = ByRole<typeof TRANSACTION_ROLES, ResolvedField> & {
  /** Nebula's `StartTime__c` is a nillable formula (measured), so rows fall back to CreatedDate. */
  readonly startTime: ResolvedTimeField;
};

export type ResolvedEntryObject = {
  readonly object: string;
  /** 3-char key prefix from describe; routes `get`/`entry` ids to their source. */
  readonly keyPrefix: string;
  readonly roles: ResolvedEntryRoles;
  /** `roles.time` when filterable, else CREATED_DATE. Drives since/until of an `entries` list. */
  readonly timeFilter: ResolvedTimeField;
  /** Order inside a transaction: the first sortable of `order`, `time`, CREATED_DATE; ties by Id. */
  readonly sequence: ResolvedField;
  readonly columns: readonly ResolvedField[];
  readonly details: readonly ResolvedDetail[];
  readonly payload?: ResolvedPayload;
  readonly levelPredicate: EntryLevelPredicate;
  readonly systemMessagePrefix?: string;
};

export type ResolvedTransactionObject = {
  readonly object: string;
  readonly keyPrefix: string;
  readonly roles: ResolvedTransactionRoles;
  /** `roles.startTime` when filterable, else CREATED_DATE. */
  readonly timeFilter: ResolvedTimeField;
  readonly columns: readonly ResolvedField[];
  readonly payload?: ResolvedPayload;
  readonly levelPredicate: HeaderLevelPredicate;
};

/** What the decoders (`decode.ts`) read from an entry object: the parts that do not describe a query. */
export type DecodableEntryObject = Pick<
  ResolvedEntryObject,
  'roles' | 'columns' | 'details' | 'payload' | 'systemMessagePrefix'
>;

/**
 * A platform event resolved against a describe, live or stored. It has no `keyPrefix`,
 * `timeFilter`, `sequence` or `levelPredicate`: those are facts about a SOQL query, and the store
 * filters and orders in memory. Its field flags `sortable` and `filterable` are always false, so
 * nothing can mistake a field for one SOQL may filter on. `object` is the describe-cased name,
 * because the CometD channel is case-sensitive and core lower-cases EntityDefinition names.
 */
export type ResolvedEventObject = DecodableEntryObject & {
  readonly object: string;
  /** `/event/<describe.name>`. The only place the channel string is built. */
  readonly channel: string;
};

export type ResolvedRecordShape =
  | { readonly kind: 'entries'; readonly entry: ResolvedEntryObject }
  | {
      readonly kind: 'transactions';
      readonly transaction: ResolvedTransactionObject;
      readonly entry: ResolvedEntryObject & { readonly parent: ResolvedField };
    };

export type ResolvedEventShape = { readonly kind: 'events'; readonly event: ResolvedEventObject };

export type ResolvedShape = ResolvedRecordShape | ResolvedEventShape;

/**
 * Ends every switch over a shape kind, so a kind added to `ResolvedShape` fails `check-types` at
 * each site. `customLogsShape.test.ts` refuses the two-way comparisons that would bypass it.
 */
export function assertNever(value: never, what: string): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(value)}`);
}

/** The object a list row shows: the header of a `transactions` source, else the entry object. */
export function listedObject(shape: ResolvedRecordShape): ResolvedTransactionObject | ResolvedEntryObject {
  switch (shape.kind) {
    case 'transactions':
      return shape.transaction;
    case 'entries':
      return shape.entry;
    default:
      return assertNever(shape, 'record shape');
  }
}

/** The header object of a `transactions` source; an `entries` source has none. */
export function headerObject(shape: ResolvedRecordShape): ResolvedTransactionObject | undefined {
  switch (shape.kind) {
    case 'transactions':
      return shape.transaction;
    case 'entries':
      return undefined;
    default:
      return assertNever(shape, 'record shape');
  }
}

type ResolvedSourceOf<S extends ResolvedShape> = {
  readonly id: SourceId;
  readonly label: string;
  readonly origin: CustomLogSourceOrigin;
  readonly namespace?: string;
  /** `SourceDefinition.digest`. Cursors carry it. */
  readonly digest: string;
  readonly shape: S;
  readonly levels: LevelTable;
  /** Definition paths dropped because describe omits them (FLS or absent). */
  readonly hidden: readonly string[];
};

/** Query builders take only this, so an event source cannot reach a SOQL query. */
export type ResolvedRecordSource = ResolvedSourceOf<ResolvedRecordShape>;
export type ResolvedEventSource = ResolvedSourceOf<ResolvedEventShape>;
export type ResolvedSource = ResolvedRecordSource | ResolvedEventSource;

export function isEventSource(source: ResolvedSource): source is ResolvedEventSource {
  return source.shape.kind === 'events';
}

/** What `sources` says of every source, ready or not: which objects it looks for, and in what shape. */
export type CatalogHead = {
  readonly id: SourceId;
  readonly label: string;
  readonly origin: CustomLogSourceOrigin;
  readonly shape: CustomLogSourceShape;
  readonly namespace?: string;
  readonly objects: CustomLogSourceObjects;
};

export type CatalogEntry = { readonly head: CatalogHead } & (
  { readonly state: 'ready'; readonly source: ResolvedSource } | Exclude<CustomLogSourceState, { state: 'ready' }>
);

export type SourceCatalog = {
  readonly username: string;
  /** Config sources in file order, then the built-ins they do not replace. Order decides key-prefix ties. */
  readonly entries: readonly CatalogEntry[];
};
