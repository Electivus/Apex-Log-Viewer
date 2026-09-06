export type DevHubConfig =
  | { mode: 'alias'; alias: string }
  | { mode: 'jwt'; clientId: string; username: string; loginUrl: string; privateKey?: string; privateKeyFile?: string };

export type DevHubSession = { targetOrg: string; cleanup: () => Promise<void> };

export function hasDevHubJwtConfig(env?: NodeJS.ProcessEnv): boolean;
export function isUsableSfdxAuthUrl(value: unknown): value is string;
export function safeSfFailureMessage(error: unknown, fallback?: string): string;

export function resolveDevHubConfig(
  env?: NodeJS.ProcessEnv,
  options?: { required?: boolean }
): DevHubConfig | undefined;
export function authenticateDevHub(
  config: DevHubConfig | undefined,
  runJson: (args: string[], options: { env: NodeJS.ProcessEnv }) => Promise<unknown>
): Promise<DevHubSession>;
export function salesforceChildEnv(env?: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function scratchSignupEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
