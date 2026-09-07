'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { generateKeyPairSync, X509Certificate, createPrivateKey } = require('node:crypto');
const spawn = require('cross-spawn');

function lifecycleInputs(values, requireFiles) {
  const mode = values['credential-mode'];
  const days = Number(values['certificate-days']);
  const storagePolicy = values['storage-policy'];
  const policyReference = values['policy-reference']?.trim();
  if (
    !['temporary', 'permanent'].includes(mode) ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 3650 ||
    !storagePolicy?.trim() ||
    (requireFiles && (!values['certificate-file'] || !values['private-key-file'])) ||
    (mode === 'permanent' && !policyReference) ||
    (mode === 'temporary' && (days > 2 || storagePolicy !== 'temporary-local'))
  ) {
    throw new Error(
      'Explicit credential lifecycle inputs are required: mode, certificate-days, storage-policy, certificate-file, private-key-file and, for permanent credentials, the approved policy-reference. Temporary proof is limited to two days and temporary-local storage.'
    );
  }
  return { mode, days, storagePolicy, ...(policyReference ? { policyReference } : {}) };
}

async function outsideRepository(directory) {
  if (!directory) throw new Error('--state-dir is required.');
  const resolved = path.resolve(directory);
  const repo = await fs.realpath(path.resolve(__dirname, '..'));
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    throw new Error('--state-dir must be outside the repository.');
  }
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(resolved);
  if (real === repo || real.startsWith(`${repo}${path.sep}`)) {
    throw new Error('--state-dir resolves inside the repository.');
  }
  return real;
}

async function secureDirectory(directory) {
  if (process.platform !== 'win32') {
    await fs.chmod(directory, 0o700);
    return;
  }
  const identity = spawn.sync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.status === 0 && identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('Cannot determine the Windows identity for private directory permissions.');
  const acl = spawn.sync(
    'icacls',
    [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
    { encoding: 'utf8', windowsHide: true }
  );
  if (acl.status !== 0)
    throw new Error('Cannot restrict the generated credential directory ACL; no credentials were written.');
}

async function readCertificate(certificateFile, privateKeyFile, lifecycle) {
  let pem, certificate, key;
  try {
    pem = await fs.readFile(certificateFile, 'utf8');
    certificate = new X509Certificate(pem);
    key = createPrivateKey(await fs.readFile(privateKeyFile));
  } catch {
    throw new Error(
      'Certificate/private-key files must contain a readable X.509 certificate and unencrypted RSA PEM key; contents withheld.'
    );
  }
  const lifetimeDays = (Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)) / 86400000;
  if (
    key.asymmetricKeyType !== 'rsa' ||
    key.asymmetricKeyDetails.modulusLength < 2048 ||
    !certificate.checkPrivateKey(key) ||
    Math.abs(lifetimeDays - lifecycle.days) > 0.01 ||
    Date.parse(certificate.validTo) <= Date.now() ||
    Date.parse(certificate.validFrom) > Date.now()
  ) {
    throw new Error(
      'Certificate/key mismatch, unsupported key, expired certificate or lifetime differs from the explicit policy.'
    );
  }
  return {
    pem,
    fingerprint: certificate.fingerprint256,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo
  };
}

async function createCertificate(values) {
  const lifecycle = lifecycleInputs(values, false);
  const root = await outsideRepository(values['state-dir']);
  const directory = path.join(root, `credentials-${lifecycle.mode}`);
  const certificateFile = path.join(directory, 'certificate.pem');
  const privateKeyFile = path.join(directory, 'private-key.pem');
  let exists = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    exists = true;
  }
  if (exists) {
    let recorded;
    try {
      recorded = JSON.parse(await fs.readFile(path.join(directory, 'lifecycle.json'), 'utf8'));
    } catch {
      throw new Error(`Existing credential directory is incomplete; preserve it for recovery: ${directory}`);
    }
    if (JSON.stringify(recorded) !== JSON.stringify(lifecycle)) {
      throw new Error(
        'Existing certificate lifecycle differs; do not overwrite credentials or infer rotation approval.'
      );
    }
  } else {
    await secureDirectory(directory);
    await fs.writeFile(path.join(directory, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2), {
      mode: 0o600,
      flag: 'wx'
    });
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    await fs.writeFile(privateKeyFile, pair.privateKey, { mode: 0o600, flag: 'wx' });
    const result = spawn.sync(
      values.openssl || 'openssl',
      [
        'req',
        '-new',
        '-x509',
        '-sha256',
        '-key',
        privateKeyFile,
        '-out',
        certificateFile,
        '-days',
        String(lifecycle.days),
        '-subj',
        '/CN=Apex Log Viewer Dev Hub Automation/O=Electivus'
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    if (result.status !== 0)
      throw new Error(`OpenSSL certificate generation failed; private recovery directory retained: ${directory}`);
    await fs.chmod(certificateFile, 0o600);
  }
  const certificate = await readCertificate(certificateFile, privateKeyFile, lifecycle);
  return {
    status: 'certificate-ready',
    ...lifecycle,
    certificateFile,
    privateKeyFile,
    fingerprint: certificate.fingerprint,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo
  };
}

module.exports = { lifecycleInputs, readCertificate, createCertificate, outsideRepository, secureDirectory };
