#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const spawn = require('cross-spawn');
const { durablePath, privateFile } = require('./devhub-operator-state');
const { secureDirectory, readCertificate } = require('./devhub-identity-credentials');
const { authenticateDevHub, validateDevHubJwt, salesforceChildEnv } = require('./devhub-auth');
const { nativeSf } = require('./devhub-identity-sf');

async function operatorInputs(directory) {
  await secureDirectory(directory);
  const read = async file => {
    try {
      return JSON.parse(await fs.readFile(await privateFile(directory, file), 'utf8'));
    } catch {
      throw new Error(
        'Durable identity journal or JWT inputs are missing or invalid; restore verified material or prepare lost-material recovery.'
      );
    }
  };
  const state = await read(path.join(directory, 'identity.json'));
  const app = state.apps?.permanent;
  if (
    state.version !== 1 ||
    !/^00D[a-zA-Z0-9]{15}$/.test(state.org) ||
    !/^005[a-zA-Z0-9]{15}$/.test(state.userId) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.owner) ||
    !app?.configured ||
    app.revoked ||
    app.name !== `ALV_DevHub_${state.owner.replaceAll('-', '').slice(0, 16)}_CI` ||
    app.marker !== `alv-devhub:${state.owner}:permanent` ||
    app.lifecycle?.mode !== 'permanent' ||
    app.lifecycle.days !== 365 ||
    !app.lifecycle.policyReference ||
    (state.rotation && !['applied', 'rolled-back'].includes(state.rotation.phase))
  ) {
    throw new Error('Durable identity ownership, lifecycle or pending recovery is invalid; no JWT session may start.');
  }
  const inputs = await read(app.inputsFile);
  if (
    inputs.username !== state.username ||
    inputs.privateKeyFile !== app.privateKeyFile ||
    inputs.loginUrl !== 'https://login.salesforce.com'
  )
    throw new Error('Durable JWT inputs differ from the recorded identity.');
  const certificate = await readCertificate(
    await privateFile(directory, app.certificateFile),
    await privateFile(directory, app.privateKeyFile),
    app.lifecycle
  );
  if (certificate.fingerprint !== app.fingerprint)
    throw new Error('Durable certificate differs from the identity journal.');
  const config = {
    mode: 'jwt',
    clientId: inputs.clientId,
    username: inputs.username,
    loginUrl: inputs.loginUrl,
    privateKeyFile: inputs.privateKeyFile
  };
  validateDevHubJwt(config);
  return { state, config, certificate };
}

function completeRecord(result) {
  if (
    result?.done !== true ||
    !Array.isArray(result.records) ||
    result.records.length !== 1 ||
    (result.totalSize !== undefined && result.totalSize !== 1)
  )
    throw new Error('Incomplete JWT identity API evidence.');
  return result.records[0];
}

async function verify({ state, config, certificate }, sf) {
  const session = await authenticateDevHub(config, async (args, options) => {
    const result = await sf(args, options);
    if (result.orgId !== state.org) throw new Error('JWT login returned another Dev Hub.');
    return { status: 0, result };
  });
  try {
    const query = soql => sf(['data', 'query', '--target-org', config.username, '--query', soql], { env: session.env });
    const org = completeRecord(await query('SELECT Id FROM Organization'));
    const user = completeRecord(await query(`SELECT Id, Username FROM User WHERE Id = '${state.userId}'`));
    if (org.Id !== state.org || user.Id !== state.userId || user.Username !== state.username)
      throw new Error('Fresh JWT API identity differs from the durable journal.');
  } finally {
    await session.cleanup();
  }
  return {
    status: 'jwt-verified',
    orgId: state.org,
    userId: state.userId,
    fingerprint: certificate.fingerprint,
    validTo: certificate.validTo,
    isolatedStateRemoved: true
  };
}

function nativeChild(file, args, { env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: 'inherit', windowsHide: true });
    child.on('error', () => reject(new Error('Cannot start the local validation command.')));
    child.on('close', code => resolve(code ?? 1));
  });
}

async function main(argv = process.argv.slice(2), { sf = nativeSf, runChild = nativeChild } = {}) {
  const separator = argv.indexOf('--');
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: separator === -1 ? argv : argv.slice(0, separator),
    allowPositionals: true,
    options: { 'state-dir': { type: 'string' } }
  });
  if (
    positionals.length !== 1 ||
    !['verify', 'run'].includes(positionals[0]) ||
    (positionals[0] === 'run') !== command.length > 0
  ) {
    throw new Error(
      'Use verify [--state-dir <durable directory>] or run [--state-dir <directory>] -- <command> [args].'
    );
  }
  const directory = await durablePath(values['state-dir']);
  const inputs = await operatorInputs(directory);
  const receipt = await verify(inputs, sf);
  if (positionals[0] === 'verify') return receipt;
  const env = salesforceChildEnv(process.env, {
    SF_DEVHUB_CLIENT_ID: inputs.config.clientId,
    SF_DEVHUB_USERNAME: inputs.config.username,
    SF_DEVHUB_LOGIN_URL: inputs.config.loginUrl,
    SF_DEVHUB_PRIVATE_KEY_FILE: inputs.config.privateKeyFile
  });
  return { ...receipt, exitCode: await runChild(command[0], command.slice(1), { env }) };
}

module.exports = { main };
if (require.main === module)
  main()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.exitCode || 0;
    })
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
