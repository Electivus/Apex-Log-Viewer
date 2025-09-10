import type * as vscode from 'vscode';
import { persistSelectedOrg, restoreSelectedOrg, pickSelectedOrg } from './orgs';
import { listOrgs } from '../salesforce/cli';
import type { OrgItem } from '../shared/types';

export class OrgManager {
  private selectedOrg: string | undefined;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.selectedOrg = restoreSelectedOrg(this.context) || undefined;
  }

  getSelectedOrg(): string | undefined {
    return this.selectedOrg;
  }

  setSelectedOrg(org?: string): void {
    this.selectedOrg = org;
    persistSelectedOrg(this.context, org);
  }

  async list(forceRefresh = false, signal?: AbortSignal): Promise<{ orgs: OrgItem[]; selected?: string }> {
    const orgs = await listOrgs(forceRefresh, signal);
    const selected = pickSelectedOrg(orgs, this.selectedOrg);
    return { orgs, selected };
  }
}
