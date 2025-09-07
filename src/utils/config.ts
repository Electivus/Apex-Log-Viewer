import * as vscode from 'vscode';

const NEW_NS = 'electivus.apexLogs';
const OLD_NS = 'sfLogs';

function resolveKeys(name: string): [string, string, string[]] {
  // Accept full keys like "sfLogs.pageSize" or "electivus.apexLogs.pageSize"
  // Prefer the new namespace, but support the old one for backward compatibility.
  let suffix = name;
  if (name.startsWith(OLD_NS + '.')) {
    suffix = name.substring(OLD_NS.length + 1);
  } else if (name.startsWith(NEW_NS + '.')) {
    suffix = name.substring(NEW_NS.length + 1);
  }
  const primary = `${NEW_NS}.${suffix}`;
  const fallback = `${OLD_NS}.${suffix}`;
  // If caller passed a different key, include it last just in case
  const extra = name === primary || name === fallback ? [] : [name];
  return [primary, fallback, extra];
}

// Local structural type for inspect results to avoid depending on exact vscode type name
interface Inspection<T> {
  key: string;
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

function hasUserOverride<T>(info: Inspection<T> | undefined): boolean {
  if (!info) return false;
  return info.globalValue !== undefined || info.workspaceValue !== undefined || info.workspaceFolderValue !== undefined;
}

export function getConfig<T>(name: string, def?: T): T {
  const cfg = vscode.workspace.getConfiguration();
  const [primary, fallback, extra] = resolveKeys(name);

  const canInspect = typeof (cfg as any).inspect === 'function';
  if (!canInspect) {
    // Fallback path for tests or environments that stub getConfiguration() and omit inspect()
    for (const key of [primary, fallback, ...extra]) {
      const v = cfg.get<T | undefined>(key);
      if (v !== undefined) return v as T;
    }
    return def as T;
  }

  // Use the new key only if explicitly set by the user
  const primaryInfo = (cfg as any).inspect(primary) as Inspection<T> | undefined;
  if (hasUserOverride(primaryInfo)) {
    const v = cfg.get<T | undefined>(primary);
    if (v !== undefined) return v as T;
  }

  // Otherwise, prefer an explicit legacy value if present
  const fallbackInfo = (cfg as any).inspect(fallback) as Inspection<T> | undefined;
  if (hasUserOverride(fallbackInfo)) {
    const v = cfg.get<T | undefined>(fallback);
    if (v !== undefined) return v as T;
  }

  // Try any additional provided key(s)
  for (const key of extra) {
    const v = cfg.get<T | undefined>(key);
    if (v !== undefined) return v as T;
  }

  // Neither key set by user; return new key's package default if available
  const v = cfg.get<T | undefined>(primary);
  if (v !== undefined) return v as T;

  return def as T;
}

/**
 * Retrieve a numeric workspace configuration, applying defaults and clamping.
 *
 * @param name configuration key (new or old namespace)
 * @param def default value if the setting is absent or invalid
 * @param min minimum inclusive value
 * @param max maximum inclusive value
 */
export function getNumberConfig(name: string, def: number, min: number, max: number): number {
  const raw = getConfig<number | undefined>(name, undefined);
  const n = raw !== undefined && Number.isFinite(raw) ? Math.floor(raw) : def;
  return Math.max(min, Math.min(max, n));
}

export function getBooleanConfig(name: string, def: boolean): boolean {
  const raw = getConfig<boolean | undefined>(name, undefined);
  return raw !== undefined ? !!raw : def;
}

export function getCliPath(): string | undefined {
  const raw = getConfig<string | undefined>('electivus.apexLogs.cliPath', '');
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function affectsConfiguration(e: vscode.ConfigurationChangeEvent, name: string): boolean {
  const [primary, fallback, extra] = resolveKeys(name);
  if (e.affectsConfiguration(primary) || e.affectsConfiguration(fallback)) return true;
  for (const key of extra) {
    if (e.affectsConfiguration(key)) return true;
  }
  return false;
}

export default getNumberConfig;
