import * as fs from 'node:fs';
import * as path from 'node:path';

export type RuntimeExecutableResolution = {
  executable: string;
  source: 'bundled' | 'configured';
  showManualOverrideWarning: boolean;
  invalidConfiguredPath?: string;
};

export function resolveRuntimeExecutable(args: {
  configuredPath: string;
  bundledPath: string;
}): RuntimeExecutableResolution {
  const configured = args.configuredPath.trim();
  if (configured && isValidConfiguredRuntimePath(configured)) {
    return {
      executable: configured,
      source: 'configured',
      showManualOverrideWarning: true
    };
  }

  const resolution: RuntimeExecutableResolution = {
    executable: args.bundledPath,
    source: 'bundled',
    showManualOverrideWarning: false
  };
  if (configured) {
    resolution.invalidConfiguredPath = configured;
  }
  return resolution;
}

function isValidConfiguredRuntimePath(configuredPath: string): boolean {
  if (configuredPath.includes('://') || configuredPath.startsWith('file:')) {
    return false;
  }
  if (!path.isAbsolute(configuredPath)) {
    return false;
  }

  try {
    if (!fs.statSync(configuredPath).isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      return true;
    }

    fs.accessSync(configuredPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
