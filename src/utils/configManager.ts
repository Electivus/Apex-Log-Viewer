import { getNumberConfig, affectsConfiguration } from './config';
import type * as vscode from 'vscode';

export class ConfigManager {
  constructor(
    private headConcurrency: number,
    private pageLimit: number,
    private tailBufferSize = 10000
  ) {}

  handleChange(e: vscode.ConfigurationChangeEvent): void {
    if (affectsConfiguration(e, 'sfLogs.headConcurrency')) {
      this.headConcurrency = getNumberConfig('sfLogs.headConcurrency', this.headConcurrency, 1, Number.MAX_SAFE_INTEGER);
    }
    if (affectsConfiguration(e, 'sfLogs.tailBufferSize')) {
      this.getTailBufferSize();
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

  getTailBufferSize(): number {
    this.tailBufferSize = getNumberConfig('sfLogs.tailBufferSize', this.tailBufferSize, 1000, Number.MAX_SAFE_INTEGER);
    return this.tailBufferSize;
  }
}
