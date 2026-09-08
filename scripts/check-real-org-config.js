#!/usr/bin/env node
'use strict';

const { resolveDevHubConfig, validateDevHubJwt } = require('./devhub-auth');

try {
  validateDevHubJwt(resolveDevHubConfig({ ...process.env, CI: 'true' }));
  if (!String(process.env.SF_SCRATCH_POOL_NAME || '').trim()) {
    throw new Error('SF_SCRATCH_POOL_NAME must be configured for the real-org workflow.');
  }
  console.info('Real-org pool and Dev Hub JWT configuration validated.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
