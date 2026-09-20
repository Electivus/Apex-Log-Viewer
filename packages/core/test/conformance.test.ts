import test from 'node:test';

import { runTypeScriptConformance } from './support/conformanceHarness.ts';

test('TypeScript public core facade conforms to the v1 behavioral contract', async () => {
  await runTypeScriptConformance();
});
