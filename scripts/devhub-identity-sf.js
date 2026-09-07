'use strict';

const spawn = require('cross-spawn');

const CODES = [
  'DUPLICATE_USERNAME',
  'LICENSE_LIMIT_EXCEEDED',
  'FIELD_INTEGRITY_EXCEPTION',
  'INVALID_CROSS_REFERENCE_KEY',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INSUFFICIENT_ACCESS',
  'INVALID_TYPE',
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
  'INVALID_SESSION_ID',
  'INVALID_GRANT',
  'INVALID_CLIENT'
];

// Classify privately, then discard all vendor text. A generic access failure is
// not evidence that an Integration license cannot support the scratch lifecycle.
function safeFailure(payload) {
  const detail = `${payload?.message || ''} ${JSON.stringify(payload)}`;
  const code = /\bCANNOT_INSERT_UPDATE_ACTIVATE_ENTITY\b/i.test(detail)
    ? 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY'
    : CODES.find(candidate => new RegExp(`\\b${candidate}\\b`, 'i').test(detail)) || 'SF_OPERATION_FAILED';
  const affectedObjects = ['ScratchOrgInfo', 'ActiveScratchOrg'].filter(name => detail.includes(name));
  const licenseRestriction =
    code === 'FIELD_INTEGRITY_EXCEPTION' &&
    affectedObjects.length > 0 &&
    /(?:user license|license (?:does not|doesn't) (?:allow|support)|not (?:allowed|supported|available) (?:for|with) .*license)/i.test(
      detail
    );
  return Object.assign(new Error(`Salesforce CLI operation failed (${code}); command output withheld.`), {
    code,
    licenseRestriction,
    affectedObjects: licenseRestriction ? affectedObjects : []
  });
}

function nativeSf(args, { env = process.env, cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SF_CLI_BIN_PATH || process.env.ALV_SF_BIN_PATH || 'sf', [...args, '--json'], {
      env,
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', () => reject(safeFailure({})));
    child.on('close', code => {
      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        reject(safeFailure({}));
        return;
      }
      if (code || (typeof payload.status === 'number' && payload.status !== 0)) reject(safeFailure(payload));
      else resolve(payload.result ?? payload);
    });
  });
}

module.exports = { nativeSf, safeFailure };
