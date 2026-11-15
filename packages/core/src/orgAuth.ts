import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

import { AuthInfo, type AuthFields } from '@salesforce/core';

/**
 * An `AuthInfo` whose saves keep the fields it changed, unless the auth file shows a write after the change.
 *
 * `@salesforce/core` stamps every field of the in-memory auth on each update and, when saving, merges the auth file
 * under `<file>.lock`, keeping the file's value of a field whose in-memory stamp is earlier than the file's mtime. 9.2
 * stamps with `performance.timeOrigin + performance.now()`, which starts from the wall clock at process start and then
 * counts on its own; whenever the wall clock gets ahead of it, a save soon after the file's last write keeps the old
 * values (#1449). 9.4 stamps in whole milliseconds and loses them on a normal clock. File times cannot order the
 * writes instead: on NTFS most back-to-back writes share one mtime.
 *
 * So the save checks the file for writes after the change. Just before an update gives a field a new value, this
 * auth info reads the auth file's mtime and the field's raw value. During its save, inside the library's lock and on
 * the file contents and mtime the library merges, a changed field is stamped 1 ns after the file's mtime, so the merge
 * keeps it, only when both are as read. A different mtime shows a write after the read. Within one NTFS tick, where
 * writes share the mtime, different bytes show a write of the field: encrypted fields get new bytes whenever a write
 * sets them. Otherwise the library merges the field as for `AuthInfo`, as it merges every field this auth info did
 * not change. Within the tick of the read, writes that leave the field's bytes as read go unseen: one that carries the
 * old value along with other changes, one that sets an unencrypted field to the value it had, or two that change and
 * restore it.
 *
 * This reads private `@salesforce/core` state. If a piece of it has another shape, or the file cannot be read or
 * parsed, the save is `AuthInfo`'s.
 */
export class PersistentAuthInfo extends AuthInfo {
  /** For each field changed since the last save, the auth file as read just before the change. */
  private readonly readBeforeChange = new Map<string, FieldOnDisk>();

  public override update(authData?: AuthFields): AuthInfo {
    if (!authData) return super.update(authData);
    const before = this.getFields(true);
    const candidates = Object.keys(authData).filter(
      key => !isDeepStrictEqual(before[key as keyof AuthFields], authData[key as keyof AuthFields])
    );
    const config = candidates.length > 0 ? authConfigOf(this) : undefined;
    const onDisk = config ? readAuthFile(config.getPath()) : UNREADABLE;
    super.update(authData);
    const after = this.getFields(true);
    for (const key of candidates) {
      if (onDisk === UNREADABLE) this.readBeforeChange.delete(key);
      else if (!isDeepStrictEqual(before[key as keyof AuthFields], after[key as keyof AuthFields])) {
        this.readBeforeChange.set(key, { mtimeNs: onDisk.mtimeNs, raw: fieldOf(onDisk.contents, key) });
      }
    }
    return this;
  }

  public override async save(authData?: AuthFields): Promise<AuthInfo> {
    if (authData) this.update(authData);
    const config = this.readBeforeChange.size > 0 ? authConfigOf(this) : undefined;
    const unhook = config ? keepUnchangedFieldsInMerge(config, new Map(this.readBeforeChange)) : undefined;
    try {
      await super.save();
    } finally {
      unhook?.();
      this.readBeforeChange.clear();
    }
    return this;
  }
}

const ABSENT = Symbol('absent from the auth file');
const UNREADABLE = Symbol('auth file unreadable');

interface FieldOnDisk {
  mtimeNs: bigint;
  raw: unknown;
}

interface FieldState {
  timestamp: unknown;
  value: unknown;
}

interface MergingAuthConfig {
  getPath(): string;
  logAndMergeContents(fileTimestamp: unknown, fileContents: unknown): unknown;
  contents: {
    readonly state: unknown;
    merge(state: Record<string, FieldState>): unknown;
  };
}

// The mtime is read first: a write between the two reads then shows as a later mtime at the save.
function readAuthFile(file: string): { mtimeNs: bigint; contents: Record<string, unknown> } | typeof UNREADABLE {
  try {
    const { mtimeNs } = statSync(file, { bigint: true });
    const contents: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isPlainObject(contents) ? { mtimeNs, contents } : UNREADABLE;
  } catch {
    // No file to merge with yet, or one the library will fail on as well.
    return UNREADABLE;
  }
}

function fieldOf(contents: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(contents, key) ? contents[key] : ABSENT;
}

/** Wraps this config's merge for the length of one save and returns the function that removes the wrapper. */
function keepUnchangedFieldsInMerge(
  config: MergingAuthConfig,
  readBeforeChange: ReadonlyMap<string, FieldOnDisk>
): () => void {
  const own = Object.getOwnPropertyDescriptor(config, 'logAndMergeContents');
  const merge = config.logAndMergeContents;
  config.logAndMergeContents = function (this: unknown, fileTimestamp: unknown, fileContents: unknown) {
    try {
      stampFieldsUnchangedOnDisk(config, readBeforeChange, fileTimestamp, fileContents);
    } catch {
      // Leave the merge to the library, as for AuthInfo.
    }
    return merge.call(this, fileTimestamp, fileContents);
  };
  return () => {
    if (own) Object.defineProperty(config, 'logAndMergeContents', own);
    else delete (config as Partial<MergingAuthConfig>).logAndMergeContents;
  };
}

function stampFieldsUnchangedOnDisk(
  config: MergingAuthConfig,
  readBeforeChange: ReadonlyMap<string, FieldOnDisk>,
  fileTimestamp: unknown,
  fileContents: unknown
): void {
  const state = config.contents.state;
  if (typeof fileTimestamp !== 'bigint' || !isPlainObject(fileContents) || !isPlainObject(state)) return;
  const later: Record<string, FieldState> = {};
  for (const [key, read] of readBeforeChange) {
    if (read.mtimeNs !== fileTimestamp || !isDeepStrictEqual(fieldOf(fileContents, key), read.raw)) continue;
    const field = state[key];
    if (isPlainObject(field) && typeof field.timestamp === 'bigint' && field.timestamp <= fileTimestamp) {
      later[key] = { value: field.value, timestamp: fileTimestamp + 1n };
    }
  }
  if (Object.keys(later).length > 0) config.contents.merge(later);
}

function authConfigOf(info: AuthInfo): MergingAuthConfig | undefined {
  try {
    const username = info.getUsername();
    const configs = (info as unknown as { stateAggregator?: { orgs?: { configs?: unknown } } }).stateAggregator?.orgs
      ?.configs;
    if (!username || typeof configs !== 'object' || configs === null) return undefined;
    const { get } = configs as { get?: unknown };
    if (typeof get !== 'function') return undefined;
    const config: unknown = get.call(configs, username);
    return isMergingAuthConfig(config) ? config : undefined;
  } catch {
    return undefined;
  }
}

function isMergingAuthConfig(config: unknown): config is MergingAuthConfig {
  if (typeof config !== 'object' || config === null) return false;
  const { getPath, logAndMergeContents, contents } = config as Partial<MergingAuthConfig>;
  return (
    typeof getPath === 'function' &&
    typeof logAndMergeContents === 'function' &&
    typeof contents === 'object' &&
    contents !== null &&
    typeof contents.merge === 'function' &&
    isPlainObject(contents.state)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
