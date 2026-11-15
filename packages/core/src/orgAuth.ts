import { promises as fs } from 'node:fs';

import { AuthInfo, StateAggregator, type AuthFields } from '@salesforce/core';

/**
 * An `AuthInfo` whose saves keep the fields it changed.
 *
 * `@salesforce/core` merges the auth file into memory on each save and keeps the file's value of a field when the
 * file's mtime is later than the stamp of the in-memory change. 9.2 stamps with `performance.timeOrigin +
 * performance.now()`, which starts from the wall clock at process start and then counts on its own. Whenever the wall
 * clock gets ahead of it, a save soon after the file's last write keeps the old values. Windows reads the start from a
 * clock up to 2 ms coarse, and a time sync, a clock step or a resume on Linux can open seconds or hours. A refresh
 * then hands jsforce the old token and drops a rotated refresh token.
 *
 * A field this auth info changed since its last save, and the save did not keep, is applied again with the file's
 * mtime set just below the new stamps, so the merge keeps it. A field it did not change keeps what the file holds,
 * which can be another process's newer token.
 */
export class PersistentAuthInfo extends AuthInfo {
  private readonly changed = new Set<string>();

  public override update(authData?: AuthFields): AuthInfo {
    super.update(authData);
    if (authData) for (const key of Object.keys(authData)) this.changed.add(key);
    return this;
  }

  public override async save(authData?: AuthFields): Promise<AuthInfo> {
    if (authData) this.update(authData);
    const intended = pick(this.getFields(true), this.changed);
    this.changed.clear();
    await super.save();
    const lost = lostFields(intended, this.getFields(true));
    const username = this.getUsername();
    if (!lost || !username) return this;

    // Both the 9.2 stamp clock and the Date.now() stamps of later versions are past this by the update below.
    const floorMs = Math.min(performance.timeOrigin + performance.now(), Date.now()) - 1;
    this.update(lost);
    this.changed.clear();
    const file = (await StateAggregator.getInstance()).orgs.getPath(username);
    const { atime } = await fs.stat(file);
    await fs.utimes(file, atime, floorMs / 1000);
    await super.save();
    return this;
  }
}

function pick(fields: AuthFields, keys: ReadonlySet<string>): AuthFields {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => keys.has(key))) as AuthFields;
}

function lostFields(intended: AuthFields, kept: AuthFields): AuthFields | undefined {
  const lost = Object.fromEntries(
    Object.entries(intended).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(kept[key as keyof AuthFields])
    )
  ) as AuthFields;
  return Object.keys(lost).length > 0 ? lost : undefined;
}
