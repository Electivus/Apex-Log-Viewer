import * as vscode from 'vscode';

export function getConfig<T>(name: string, def?: T): T {
  return vscode.workspace.getConfiguration().get<T>(name, def as T);
}

export function getNumberConfig(name: string, def: number, min: number, max: number): number {
  const raw = getConfig<number | undefined>(name, undefined);
  const value = raw !== undefined && Number.isFinite(raw) ? Math.floor(raw) : def;
  return Math.max(min, Math.min(max, value));
}

export function getBooleanConfig(name: string, def: boolean): boolean {
  return Boolean(getConfig<boolean>(name, def));
}

export function affectsConfiguration(event: vscode.ConfigurationChangeEvent, name: string): boolean {
  return event.affectsConfiguration(name);
}

export default getNumberConfig;
