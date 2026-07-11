import { getNumberConfig, affectsConfiguration } from './config';
import type * as vscode from 'vscode';

export class ConfigManager {
  constructor(private headConcurrency: number, private pageLimit: number) {
    this.headConcurrency = getNumberConfig('electivus.apexLogViewer.logs.processingConcurrency', this.headConcurrency, 1, Number.MAX_SAFE_INTEGER);
  }

  handleChange(e: vscode.ConfigurationChangeEvent): void {
    if (affectsConfiguration(e, 'electivus.apexLogViewer.logs.processingConcurrency')) {
      this.headConcurrency = getNumberConfig(
        'electivus.apexLogViewer.logs.processingConcurrency',
        this.headConcurrency,
        1,
        Number.MAX_SAFE_INTEGER
      );
    }
  }

  getHeadConcurrency(): number {
    return this.headConcurrency;
  }

  getPageLimit(): number {
    const configuredLimit = getNumberConfig('electivus.apexLogViewer.logs.pageSize', this.pageLimit, 10, Number.MAX_SAFE_INTEGER);
    this.pageLimit = Math.min(configuredLimit, 200);
    return this.pageLimit;
  }

  shouldLoadFullLogBodies(): boolean {
    return true;
  }
}
