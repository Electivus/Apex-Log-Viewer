import type * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { pickSelectedOrg } from './orgs';
import { listOrgs } from '../salesforce/cli';
import type { OrgItem } from '../shared/types';
import { getWorkspaceRoot } from './workspace';
import { logWarn } from './logger';
import { getErrorMessage } from './error';

export class OrgManager {
  private selectedOrg: string | undefined;
  private initialSelectionLoaded = false;
  private initialSelectionPromise: Promise<void> | undefined;
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
    await this.ensureInitialSelection(orgs);
    const selected = pickSelectedOrg(orgs, this.selectedOrg);
    this.selectedOrg = selected;
    return { orgs, selected };
  }

  private async ensureInitialSelection(orgs: OrgItem[]): Promise<void> {
    if (this.initialSelectionLoaded) {
      return;
    }
    if (this.initialSelectionPromise) {
      await this.initialSelectionPromise;
      return;
    }
    this.initialSelectionPromise = (async () => {
      const candidate = await readProjectDefaultOrg();
      if (!candidate) {
        return;
      }
      const trimmed = candidate.trim();
      if (!trimmed) {
        return;
      }
      if (this.selectedOrg !== undefined) {
        return;
      }
      this.selectedOrg = trimmed;
      const match = orgs.find(o => o.username === trimmed || o.alias === trimmed);
      if (match?.username) {
        this.selectedOrg = match.username;
      }
    })()
      .catch(e => {
        logWarn('OrgManager: failed to load project default org ->', getErrorMessage(e));
      })
      .finally(() => {
        this.initialSelectionLoaded = true;
        this.initialSelectionPromise = undefined;
      });
    await this.initialSelectionPromise;
  }
}

type ProjectConfigSource = {
  segments: string[];
  keys: string[];
};

const PROJECT_CONFIG_SOURCES: ProjectConfigSource[] = [
  { segments: ['.sf', 'config.json'], keys: ['target-org', 'targetOrg', 'defaultusername', 'defaultUsername'] },
  { segments: ['.sfdx', 'sfdx-config.json'], keys: ['defaultusername', 'defaultUsername', 'target-org', 'targetOrg'] },
  { segments: ['.sfdx', 'config.json'], keys: ['defaultusername', 'defaultUsername', 'target-org', 'targetOrg'] }
];

async function readProjectDefaultOrg(): Promise<string | undefined> {
  const root = getWorkspaceRoot();
  if (!root) {
    return undefined;
  }
  for (const source of PROJECT_CONFIG_SOURCES) {
    const filePath = path.join(root, ...source.segments);
    const value = await readStringProperties(filePath, source.keys);
    if (value) {
      return value;
    }
  }
  return undefined;
}

async function readStringProperties(filePath: string, keys: string[]): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    for (const key of keys) {
      const val = (data as Record<string, unknown> | undefined)?.[key];
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      return undefined;
    }
    logWarn('OrgManager: failed to read project config file ->', filePath, getErrorMessage(e));
  }
  return undefined;
}
