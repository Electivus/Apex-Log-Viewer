export type DevHubConfig = {
  mode: 'jwt';
  clientId: string;
  username: string;
  loginUrl: string;
  privateKey?: string;
  privateKeyFile?: string;
};

export type DevHubSession = {
  targetOrg: string;
  env: NodeJS.ProcessEnv;
  publishScratch: (alias: string, options?: { setDefault?: boolean }) => Promise<void>;
  deleteScratch: (alias: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

export function hasDevHubJwtConfig(env?: NodeJS.ProcessEnv): boolean;
export function requiresScratchSetup(
  scope?: string,
  options?: { smokeVsix?: boolean },
  env?: NodeJS.ProcessEnv
): boolean;
export function validateDevHubJwt(config: Extract<DevHubConfig, { mode: 'jwt' }>): void;
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
