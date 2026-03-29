export type RuntimeExecutableResolution = {
  executable: string;
  source: 'bundled' | 'configured';
  showManualOverrideWarning: boolean;
};

export function resolveRuntimeExecutable(args: {
  configuredPath: string;
  bundledPath: string;
}): RuntimeExecutableResolution {
  const configured = args.configuredPath.trim();
  if (configured) {
    return {
      executable: configured,
      source: 'configured',
      showManualOverrideWarning: true
    };
  }

  return {
    executable: args.bundledPath,
    source: 'bundled',
    showManualOverrideWarning: false
  };
}
