import type { OrgAuth } from './types';

const DEFAULT_API_VERSION = '64.0';
let API_VERSION = DEFAULT_API_VERSION;
const orgApiVersionOverrideByOrg = new Map<string, string>();
const orgApiVersionWarningByOrg = new Map<string, string>();

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeOrgKey(auth: OrgAuth): string {
  const instance = stripTrailingSlash(String(auth.instanceUrl || '').trim()).toLowerCase();
  if (instance) {
    return instance;
  }
  return String(auth.username || '').trim().toLowerCase();
}

export function parseApiVersion(value: string | undefined): number | undefined {
  const s = String(value || '').trim();
  if (!/^\d+\.\d+$/.test(s)) {
    return undefined;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function extractApiVersionFromUrl(urlString: string): string | undefined {
  try {
    const url = new URL(urlString);
    const m = url.pathname.match(/\/services\/data\/v(\d+\.\d+)(?:\/|$)/i);
    return m?.[1];
  } catch {
    return undefined;
  }
}

export function replaceApiVersionInUrl(urlString: string, version: string): string {
  const url = new URL(urlString);
  url.pathname = url.pathname.replace(/\/services\/data\/v\d+\.\d+(?=\/|$)/i, `/services/data/v${version}`);
  return url.toString();
}

function clearApiVersionFallbackState(): void {
  orgApiVersionOverrideByOrg.clear();
  orgApiVersionWarningByOrg.clear();
}

export function setApiVersion(v?: string): void {
  const s = (v || '').trim();
  if (/^\d+\.\d+$/.test(s)) {
    const changed = API_VERSION !== s;
    API_VERSION = s;
    if (changed) {
      clearApiVersionFallbackState();
    }
  }
}

export function resetApiVersion(): void {
  const changed = API_VERSION !== DEFAULT_API_VERSION;
  API_VERSION = DEFAULT_API_VERSION;
  if (changed) {
    clearApiVersionFallbackState();
  }
}

export function getApiVersion(): string {
  return API_VERSION;
}

export function getEffectiveApiVersion(auth?: OrgAuth): string {
  if (!auth) {
    return API_VERSION;
  }
  return orgApiVersionOverrideByOrg.get(normalizeOrgKey(auth)) || API_VERSION;
}

export function getApiVersionFallbackWarning(auth?: OrgAuth): string | undefined {
  if (!auth) {
    return undefined;
  }
  return orgApiVersionWarningByOrg.get(normalizeOrgKey(auth));
}

export function recordApiVersionFallback(
  auth: OrgAuth,
  requestedVersion: string,
  orgMaxVersion: string
): { warning: string; changed: boolean } {
  const orgKey = normalizeOrgKey(auth);
  orgApiVersionOverrideByOrg.set(orgKey, orgMaxVersion);
  const warning = `sourceApiVersion ${requestedVersion} > org max ${orgMaxVersion}; falling back to ${orgMaxVersion}`;
  const previousWarning = orgApiVersionWarningByOrg.get(orgKey);
  orgApiVersionWarningByOrg.set(orgKey, warning);
  return {
    warning,
    changed: previousWarning !== warning
  };
}

export function __resetApiVersionFallbackStateForTests(): void {
  clearApiVersionFallbackState();
}
