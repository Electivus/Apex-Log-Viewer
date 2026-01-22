import * as nls from 'vscode-nls';

// Configure vscode-nls to read from generated .nls.json files next to the bundle
nls.config({ messageFormat: nls.MessageFormat.file })();

export const localize = nls.loadMessageBundle();
