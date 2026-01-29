export type CliParseOptions = {
  projectDir?: string;
  sfBin?: string;
  debug?: boolean;
};

export type CliParseResult = {
  options: CliParseOptions;
  showHelp?: boolean;
  showVersion?: boolean;
  error?: string;
};

export function parseArgs(argv: string[]): CliParseResult {
  const options: CliParseOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--help':
      case '-h':
        return { options, showHelp: true };
      case '--version':
      case '-v':
        return { options, showVersion: true };
      case '--project-dir': {
        const value = argv[index + 1];
        if (!value) {
          return { options, error: 'Missing value for --project-dir' };
        }
        options.projectDir = value;
        index += 1;
        break;
      }
      case '--sf-bin': {
        const value = argv[index + 1];
        if (!value) {
          return { options, error: 'Missing value for --sf-bin' };
        }
        options.sfBin = value;
        index += 1;
        break;
      }
      case '--debug':
        options.debug = true;
        break;
      default:
        if (arg.startsWith('-')) {
          return { options, error: `Unknown argument: ${arg}` };
        }
        return { options, error: `Unexpected argument: ${arg}` };
    }
  }

  return { options };
}
