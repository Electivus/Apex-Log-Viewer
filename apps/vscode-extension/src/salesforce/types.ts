import type { ApexLogRow as SApexLogRow, OrgItem as SOrgItem } from '../shared/types';

export type ApexLogRow = SApexLogRow;
export type OrgItem = SOrgItem;

export type OrgAuth = {
  accessToken: string;
  instanceUrl: string;
  username?: string;
};
