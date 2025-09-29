import type * as vscode from 'vscode';
import { pickSelectedOrg } from './orgs';
import { listOrgs } from '../salesforce/cli';
import type { OrgItem } from '../shared/types';

export class OrgManager {
  private selectedOrg: string | undefined;
  constructor(context?: vscode.ExtensionContext) {
    void context;
    this.selectedOrg = undefined;
  }

  getSelectedOrg(): string | undefined {
    return this.selectedOrg;
  }

  setSelectedOrg(org?: string): void {
    this.selectedOrg = org;
  }

  async list(forceRefresh = false, signal?: AbortSignal): Promise<{ orgs: OrgItem[]; selected?: string }> {
    const orgs = await listOrgs(forceRefresh, signal);
    const selected = pickSelectedOrg(orgs, this.selectedOrg);
    return { orgs, selected };
  }
}
