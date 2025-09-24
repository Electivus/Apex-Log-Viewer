import { getNumberConfig, getBooleanConfig, affectsConfiguration } from './config';
import type * as vscode from 'vscode';

export class ConfigManager {
  constructor(
    private headConcurrency: number,
    private pageLimit: number,
    private prefetchLogBodies: boolean
  ) {}

  handleChange(e: vscode.ConfigurationChangeEvent): void {
    if (affectsConfiguration(e, 'sfLogs.headConcurrency')) {
      this.headConcurrency = getNumberConfig('sfLogs.headConcurrency', this.headConcurrency, 1, Number.MAX_SAFE_INTEGER);
    }
    if (affectsConfiguration(e, 'sfLogs.prefetchLogBodies')) {
      this.prefetchLogBodies = getBooleanConfig('sfLogs.prefetchLogBodies', this.prefetchLogBodies);
    }
  }

  getHeadConcurrency(): number {
    return this.headConcurrency;
  }

  getPageLimit(): number {
    const configuredLimit = getNumberConfig('sfLogs.pageSize', this.pageLimit, 10, Number.MAX_SAFE_INTEGER);
    this.pageLimit = Math.min(configuredLimit, 200);
    return this.pageLimit;
  }

  getPrefetchLogBodies(): boolean {
    this.prefetchLogBodies = getBooleanConfig('sfLogs.prefetchLogBodies', this.prefetchLogBodies);
    return this.prefetchLogBodies;
  }
}
