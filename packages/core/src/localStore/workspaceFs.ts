import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The filesystem primitives every `apexlogs/` writer in core shares: the symlink guard, the atomic
// writer, the owner directory format, a durable appender and the fenced capture lease. Internal to
// core: only logLifecycle.ts and customLogs/events/store.ts import it (customLogsBoundary.test.ts).

let gitignoreUpdateQueue: Promise<void> = Promise.resolve();

/** Amends `<root>/.gitignore` only when it already exists. */
export async function ensureWorkspaceLogIgnore(workspaceRoot: string): Promise<void> {
  const update = async (): Promise<void> => {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const stat = await fs.lstat(gitignorePath).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) return;
    const content = await fs.readFile(gitignorePath, 'utf8');
    const hasEntry = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .some(line => line === 'apexlogs' || line === 'apexlogs/' || line === '/apexlogs' || line === '/apexlogs/');
    if (hasEntry) return;
    const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
    await fs.appendFile(gitignorePath, `${separator}apexlogs/\n`, 'utf8');
  };
  const current = gitignoreUpdateQueue.then(update, update);
  gitignoreUpdateQueue = current.catch(() => undefined);
  await current.catch(() => undefined);
}

export async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function isRealDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directoryPath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Refuses symlinks, non-directories and paths that escape `workspaceRoot`, one segment at a time. */
export async function ensureRealDirectoryPath(
  workspaceRoot: string,
  directoryPath: string,
  createMissing: boolean,
  treatNonDirectoryAsMissing = false
): Promise<boolean> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedDirectory = path.resolve(directoryPath);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Apex log directory escapes the workspace root: ${resolvedDirectory}`);
  }

  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  const inspectDirectory = async (current: string, mayCreate: boolean): Promise<boolean> => {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        if (!mayCreate) return false;
        try {
          await fs.mkdir(current);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        }
        stat = await fs.lstat(current);
      } else {
        throw error;
      }
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Apex log directory must be a real directory: ${current}`);
    }
    if (!stat.isDirectory()) {
      if (treatNonDirectoryAsMissing) return false;
      throw new Error(`Apex log directory must be a real directory: ${current}`);
    }
    return true;
  };

  if (!(await inspectDirectory(resolvedRoot, false))) {
    throw new Error(`Apex log workspace root does not exist: ${resolvedRoot}`);
  }
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!(await inspectDirectory(current, createMissing))) return false;
  }
  return true;
}

export async function ensureRegularFileOrAbsent(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Apex log state path must be a regular file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function regularFileExists(filePath: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Apex log state path must be a regular file: ${filePath}`);
  }
  return true;
}

export function safeUsername(value: string | undefined): string {
  const encoded = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.@-]+/g, '_');
  return encoded && encoded !== '.' && encoded !== '..' ? encoded : 'default';
}

/** `<root>/apexlogs/orgs/<safeUsername>`: the org directory the Apex log lifecycle and the event store key by. */
export function orgDirectory(workspaceRoot: string, username: string): string {
  return path.join(workspaceRoot, 'apexlogs', 'orgs', safeUsername(username));
}

const WIN32_IGNORED_DIRECTORY_SYNC_CODES: ReadonlySet<string> = new Set(['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP']);

/**
 * Whether a failed directory fsync may be ignored. Only on win32, where opening or flushing a directory
 * handle may be refused with EPERM, EISDIR, EINVAL or ENOTSUP. Every other platform and code is a failure.
 */
export function isIgnorableDirectorySyncError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32' || !(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && WIN32_IGNORED_DIRECTORY_SYNC_CODES.has(code);
}

/** fsync of a directory, so a file created or renamed in it survives an OS crash. */
export async function syncDirectory(
  directoryPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  try {
    const directory = await fs.open(directoryPath, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!isIgnorableDirectorySyncError(error, platform)) throw error;
  }
}

export type WriteFileAtomicOptions = Readonly<{
  /**
   * Make the write survive an OS crash: the temporary file is `datasync`ed before it is renamed or
   * linked into place, and the directory is fsynced afterwards so the new name is on disk too
   * (`syncDirectory`: best effort on win32 only). The Apex log lifecycle does not pass it.
   */
  syncDirectory?: boolean;
}>;

/**
 * Temp file in the same directory, then `rename` (replace) or `link` (create-if-absent). Returns false
 * when `keepExisting` is set and a regular file already exists.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
  keepExisting: boolean,
  options?: WriteFileAtomicOptions
): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const temporary = await fs.open(temporaryPath, 'w');
    try {
      await temporary.writeFile(contents, 'utf8');
      if (options?.syncDirectory) await temporary.datasync();
    } finally {
      await temporary.close();
    }
    if (keepExisting) {
      try {
        await fs.link(temporaryPath, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && (await isRegularFile(filePath))) return false;
        throw error;
      }
    } else {
      await fs.rename(temporaryPath, filePath);
    }
    if (options?.syncDirectory) await syncDirectory(path.dirname(filePath));
    return true;
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: WriteFileAtomicOptions
): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, false, options);
}

/**
 * An append-only file with exactly one writer for its whole life (the caller guarantees it: event
 * files carry the writer id in their name). `append` hands every byte to the file and `datasync`s
 * before it resolves, so the data is on disk before the caller advances a checkpoint. Calls queue in
 * order, so two appends never interleave their bytes. A rejected append closes the appender: every
 * later call rejects, so a torn tail is never followed by more bytes in the same file. Readers parse
 * only up to the last newline.
 */
export type DurableAppender = {
  append(text: string): Promise<void>;
  close(): Promise<void>;
};

export class AppenderClosedError extends Error {
  public override readonly name = 'AppenderClosedError';

  constructor(public readonly filePath: string) {
    super(`The append-only file is closed and accepts no more writes: ${filePath}`);
  }
}

export async function openDurableAppender(workspaceRoot: string, filePath: string): Promise<DurableAppender> {
  const directory = path.dirname(filePath);
  await ensureRealDirectoryPath(workspaceRoot, directory, true);
  const created = !(await regularFileExists(filePath));
  const handle = await fs.open(filePath, 'a');
  let closed = false;
  const closeHandle = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  try {
    // A link planted between the check and the open would have been followed; refuse it now.
    await regularFileExists(filePath);
    if (created) await syncDirectory(directory);
  } catch (error) {
    await closeHandle().catch(() => undefined);
    throw error;
  }
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(step: () => Promise<T>): Promise<T> => {
    const result = queue.then(step);
    queue = result.catch(() => undefined);
    return result;
  };
  return {
    append: text =>
      enqueue(async () => {
        if (closed) throw new AppenderClosedError(filePath);
        try {
          await handle.appendFile(text, 'utf8');
          await handle.datasync();
        } catch (error) {
          await closeHandle().catch(() => undefined);
          throw error;
        }
      }),
    close: () => enqueue(closeHandle)
  };
}

// Fenced lease: one capture writer per event store across processes. Data files are per writer, so a
// lease handed over while an old writer still appends cannot corrupt data; the checkpoint is the one
// shared file, and `stillHeld()` fences it: the holder re-reads the lease immediately before every
// checkpoint commit and stops when the token is not its own.
//
// Reclaim rule: only when the holder's pid is dead on this host. No heartbeat, no age limit, no
// time-based stealing (a suspended laptop must not lose its lease to a second window). A holder on
// another host, or a pid that is alive, reused or unknown, keeps the lease. `os.hostname()` can change
// on macOS between networks, so a dead local holder written under the old name reads as another host
// until the user deletes the lease file; the standby text names pid and host for that reason.

const LEASE_TOKEN = /^[0-9a-f]{16}$/;
const LEASE_SURFACES: ReadonlySet<string> = new Set(['vscode', 'cli']);
const LEASE_RECLAIM_SETTLE_MS = 1_000;
const LEASE_RECLAIM_POLL_MS = 10;

export type LeaseOwner = Readonly<{
  version: 1;
  pid: number;
  /** Random fencing token, 16 hex. Written once; `stillHeld()` compares it. */
  token: string;
  host: string;
  surface: 'vscode' | 'cli';
  startedAt: string;
}>;

export type Lease = {
  readonly owner: LeaseOwner;
  /** Re-reads the lease file. False when it is gone or names another token. */
  stillHeld(): Promise<boolean>;
  /** Unlinks the lease only if it still carries this token. Idempotent. */
  release(): Promise<void>;
};

export type LeaseAttempt = { acquired: Lease } | { heldBy: LeaseOwner };

export class LeaseUnreadableError extends Error {
  public override readonly name = 'LeaseUnreadableError';

  constructor(public readonly leasePath: string) {
    super(`The capture lease at ${leasePath} is unreadable. Delete it if no capture is running.`);
  }
}

export type PidLiveness = 'alive' | 'dead' | 'unknown';

export function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    return code === 'EPERM' ? 'alive' : 'unknown';
  }
}

export type LeaseHost = Readonly<{ host: string; pidAlive(pid: number): PidLiveness }>;

export function judgeLease(owner: LeaseOwner, here: LeaseHost): 'reclaim' | 'held' {
  if (owner.host !== here.host) return 'held';
  return here.pidAlive(owner.pid) === 'dead' ? 'reclaim' : 'held';
}

function parseLeaseOwner(raw: string): LeaseOwner | undefined {
  let parsed: Partial<LeaseOwner>;
  try {
    parsed = JSON.parse(raw) as Partial<LeaseOwner>;
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    parsed.version !== 1 ||
    !Number.isSafeInteger(parsed.pid) ||
    Number(parsed.pid) <= 0 ||
    typeof parsed.token !== 'string' ||
    !LEASE_TOKEN.test(parsed.token) ||
    typeof parsed.host !== 'string' ||
    typeof parsed.surface !== 'string' ||
    !LEASE_SURFACES.has(parsed.surface) ||
    typeof parsed.startedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    version: 1,
    pid: Number(parsed.pid),
    token: parsed.token,
    host: parsed.host,
    surface: parsed.surface,
    startedAt: parsed.startedAt
  };
}

/** A small file's content, or undefined when it is absent. A symlink or a non-file is unreadable. */
async function readSmallFile(filePath: string): Promise<string | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new LeaseUnreadableError(filePath);
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

// Published whole through a temp file and a link, so the name never holds a partial record: a contender
// never reads a half-written lease, and a crash mid-write leaves no lease for the next run to trip over.
async function createIfAbsent(filePath: string, contents: string): Promise<boolean> {
  try {
    return await writeFileAtomic(filePath, contents, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

// Of several processes that read the same dead holder, only the one whose marker create succeeds unlinks
// it, and only while the file still carries the content it judged. The marker holds the elector's own
// owner record, so a marker left by an elector that crashed is recognizable and cleared on sight; a live
// elector is waited for until the lease changes. 'held' means the lease is still the dead record after
// that wait, so the caller reports it instead of looping.
async function reclaimDeadLease(
  leasePath: string,
  deadRecord: string,
  deadHolder: LeaseOwner,
  electorRecord: string,
  here: LeaseHost
): Promise<'retry' | 'held'> {
  const marker = `${leasePath}.reclaim-${deadHolder.token}`;
  if (await createIfAbsent(marker, electorRecord)) {
    if ((await readSmallFile(leasePath)) === deadRecord) await unlinkIfPresent(leasePath);
    await unlinkIfPresent(marker);
    return 'retry';
  }
  const markerRecord = await readSmallFile(marker);
  if (markerRecord === undefined) return 'retry';
  const elector = parseLeaseOwner(markerRecord);
  if (elector && judgeLease(elector, here) === 'reclaim') {
    if ((await readSmallFile(marker)) === markerRecord) await unlinkIfPresent(marker);
    return 'retry';
  }
  const deadline = Date.now() + LEASE_RECLAIM_SETTLE_MS;
  while ((await readSmallFile(leasePath)) === deadRecord) {
    if (Date.now() >= deadline) return 'held';
    await new Promise(resolve => setTimeout(resolve, LEASE_RECLAIM_POLL_MS));
  }
  return 'retry';
}

export async function tryAcquireLease(
  workspaceRoot: string,
  leasePath: string,
  surface: LeaseOwner['surface'],
  here: LeaseHost = { host: os.hostname(), pidAlive: pidLiveness }
): Promise<LeaseAttempt> {
  await ensureRealDirectoryPath(workspaceRoot, path.dirname(leasePath), true);
  const owner: LeaseOwner = {
    version: 1,
    pid: process.pid,
    token: randomBytes(8).toString('hex'),
    host: here.host,
    surface,
    startedAt: new Date().toISOString()
  };
  const serialized = JSON.stringify(owner);
  const tokenOnDisk = async (): Promise<string | undefined> => {
    const record = await readSmallFile(leasePath);
    return record === undefined ? undefined : parseLeaseOwner(record)?.token;
  };
  const lease: Lease = {
    owner,
    stillHeld: async () => (await tokenOnDisk()) === owner.token,
    release: async () => {
      if ((await tokenOnDisk()) === owner.token) await unlinkIfPresent(leasePath);
    }
  };

  for (;;) {
    if (await createIfAbsent(leasePath, serialized)) return { acquired: lease };
    const record = await readSmallFile(leasePath);
    if (record === undefined) continue;
    const holder = parseLeaseOwner(record);
    if (!holder) throw new LeaseUnreadableError(leasePath);
    if (judgeLease(holder, here) === 'held') return { heldBy: holder };
    if ((await reclaimDeadLease(leasePath, record, holder, serialized, here)) === 'held') return { heldBy: holder };
  }
}
