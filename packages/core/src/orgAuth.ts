import { statSync } from 'node:fs';

import { AuthInfo, type AuthFields } from '@salesforce/core';

/**
 * An `AuthInfo` whose saves keep the fields it changed.
 *
 * `@salesforce/core` stamps every field of the in-memory auth on each update and, when saving, keeps the auth file's
 * value of a field whose stamp is not later than the file's mtime. 9.2 stamps with `performance.timeOrigin +
 * performance.now()`, which starts from the wall clock at process start and then counts on its own. Whenever the wall
 * clock gets ahead of it, a save soon after the file's last write keeps the old values. Windows reads the start from a
 * clock up to 2 ms coarse, and the clock of a long-lived Mac process falls behind by about 0.34 ms a minute. A refresh
 * then hands jsforce the old token and drops a rotated refresh token.
 *
 * An update that gives a field a new value remembers a stamp for it 1 ns after the auth file's mtime at that moment.
 * Each save applies the remembered stamps that are later than the library's, then writes once. The save keeps such a
 * field over every write the file held when it changed, and still loses it to a later write, as a correct clock
 * would. Fields this auth info did not change keep the stamps the library gives them, so the save takes the file's
 * value for them when the file's mtime is later than the library's stamp of this auth info's last update. The library
 * stamps every field anew on each update, so, as with `AuthInfo`, a file written between loading and that update
 * still loses them to the values held in memory unless the library's clock trails. This reads private
 * `@salesforce/core` 9.2 state; if that state has another shape, or the file cannot be read, the auth info behaves as
 * `AuthInfo` does.
 */
export class PersistentAuthInfo extends AuthInfo {
  /** The stamp each field this auth info changed since its last save should have. */
  private readonly ownStamps = new Map<string, bigint>();

  public override update(authData?: AuthFields): AuthInfo {
    const before = authData ? this.getFields(true) : {};
    super.update(authData);
    if (!authData) return this;
    const changed = Object.entries(authData)
      .filter(([key, value]) => !sameValue(before[key as keyof AuthFields], value))
      .map(([key]) => key);
    const mtimeNs = changed.length > 0 ? authFileMtimeNs(authConfigOf(this)) : undefined;
    if (mtimeNs !== undefined) {
      for (const key of changed) this.ownStamps.set(key, mtimeNs + 1n);
    }
    return this;
  }

  public override async save(authData?: AuthFields): Promise<AuthInfo> {
    if (authData) this.update(authData);
    applyStamps(authConfigOf(this), this.ownStamps);
    await super.save();
    this.ownStamps.clear();
    return this;
  }
}

interface FieldState {
  timestamp: unknown;
  value: unknown;
}

interface StampedAuthConfig {
  getPath(): string;
  contents: {
    state: Record<string, FieldState | undefined>;
    merge(state: Record<string, FieldState>): unknown;
  };
}

function authFileMtimeNs(config: StampedAuthConfig | undefined): bigint | undefined {
  if (!config) return undefined;
  try {
    return statSync(config.getPath(), { bigint: true }).mtimeNs;
  } catch {
    // No file yet, or none we can stat: the save has nothing to merge these fields against, or fails on its own.
    return undefined;
  }
}

function applyStamps(config: StampedAuthConfig | undefined, stamps: ReadonlyMap<string, bigint>): void {
  if (!config || stamps.size === 0) return;
  const state = config.contents.state;
  const later: Record<string, FieldState> = {};
  for (const [key, timestamp] of stamps) {
    const field = state[key];
    // A field read back from a later write of the file already has that write's later stamp.
    if (field && typeof field.timestamp === 'bigint' && field.timestamp < timestamp) {
      later[key] = { ...field, timestamp };
    }
  }
  config.contents.merge(later);
}

function authConfigOf(info: AuthInfo): StampedAuthConfig | undefined {
  const username = info.getUsername();
  const configs = (info as unknown as { stateAggregator?: { orgs?: { configs?: unknown } } }).stateAggregator?.orgs
    ?.configs;
  if (!username || !(configs instanceof Map)) return undefined;
  const config: unknown = configs.get(username);
  return isStampedAuthConfig(config) ? config : undefined;
}

function isStampedAuthConfig(config: unknown): config is StampedAuthConfig {
  if (typeof config !== 'object' || config === null) return false;
  const { getPath, contents } = config as Partial<StampedAuthConfig>;
  return (
    typeof getPath === 'function' &&
    typeof contents === 'object' &&
    contents !== null &&
    typeof contents.merge === 'function' &&
    typeof contents.state === 'object'
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
