import * as vscode from 'vscode';

/**
 * Retrieve a numeric workspace configuration, applying defaults and clamping.
 *
 * @param name configuration key
 * @param def default value if the setting is absent or invalid
 * @param min minimum inclusive value
 * @param max maximum inclusive value
 */
export function getNumberConfig(name: string, def: number, min: number, max: number): number {
  const cfg = vscode.workspace.getConfiguration();
  const raw = cfg.get<number>(name);
  const n = raw && Number.isFinite(raw) ? Math.floor(raw) : def;
  return Math.max(min, Math.min(max, n));
}

export default getNumberConfig;
