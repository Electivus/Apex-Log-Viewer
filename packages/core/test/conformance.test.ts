import test from 'node:test';

import { runTypeScriptConformance } from './support/conformanceHarness.ts';

test('TypeScript public runtime facade conforms to the shared v1 corpus', async () => {
  await runTypeScriptConformance();
});
