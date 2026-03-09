import { resolveSupportExtensionIds } from '../vscode';

describe('resolveSupportExtensionIds', () => {
  test('keeps replay debugger support local to the scenario', () => {
    expect(resolveSupportExtensionIds(['salesforce.salesforcedx-vscode-apex-replay-debugger'])).toEqual([
      'salesforce.salesforcedx-vscode-apex-replay-debugger'
    ]);
  });

  test('dedupes and trims manifest and scenario extension ids', () => {
    expect(
      resolveSupportExtensionIds(
        [' salesforce.salesforcedx-vscode-core ', '', 'salesforce.salesforcedx-vscode-core'],
        ['salesforce.salesforcedx-vscode-apex-replay-debugger', 'salesforce.salesforcedx-vscode-core']
      )
    ).toEqual(['salesforce.salesforcedx-vscode-core', 'salesforce.salesforcedx-vscode-apex-replay-debugger']);
  });
});
