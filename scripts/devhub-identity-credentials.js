'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { generateKeyPairSync, X509Certificate, createPrivateKey } = require('node:crypto');
const spawn = require('cross-spawn');
const { durablePath } = require('./devhub-operator-state');

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
  // A fresh protected DACL removes unexpected explicit ACEs too. Use Windows
  // PowerShell's .NET Framework APIs directly so a PowerShell 7 PSModulePath
  // inherited by the child cannot redirect Get-Acl/Set-Acl to incompatible modules.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:ALV_IDENTITY_ACL_DIRECTORY
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$security = [System.Security.AccessControl.DirectorySecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($principal in @($current, $system)) {
  $security.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($principal,
    [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit,
    [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
}
[System.IO.Directory]::SetAccessControl($target, $security)
$actual = [System.IO.Directory]::GetAccessControl($target)
$rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if (!$actual.AreAccessRulesProtected -or $rules.Count -ne 2) { throw 'Private directory DACL verification failed.' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($current.Value, $system.Value) -or $rule.IsInherited -or
      $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or
      $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne 'None') { throw 'Unexpected private directory ACE.' }
}
$pending = [System.Collections.Generic.Queue[string]]::new()
$pending.Enqueue($target)
while ($pending.Count) {
  foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($pending.Dequeue())) {
    $attributes = [System.IO.File]::GetAttributes($entry)
    if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not allowed in private state.' }
    if ($attributes -band [System.IO.FileAttributes]::Directory) {
      $entryAcl = [System.IO.Directory]::GetAccessControl($entry)
      $pending.Enqueue($entry)
    } else { $entryAcl = [System.IO.File]::GetAccessControl($entry) }
    foreach ($rule in $entryAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.IdentityReference.Value -notin @($current.Value, $system.Value)) { throw 'Unexpected descendant ACE; sensitive writes stopped.' }
    }
  }
}`;
  const acl = spawn.sync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ALV_IDENTITY_ACL_DIRECTORY: directory }
  });
  if (acl.status !== 0)
    throw new Error(
      'Cannot establish and verify the private directory ACL, or a descendant has unexpected access; sensitive writes stopped.'
    );
}

async function readCertificate(certificateFile, privateKeyFile, lifecycle) {
  if (lifecycle.mode === 'permanent') {
    await durablePath(certificateFile);
    await durablePath(privateKeyFile);
  }
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
  if (!values['state-dir']) throw new Error('--state-dir is required.');
  if (lifecycle.mode === 'permanent') await durablePath(values['state-dir'], { create: true });
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
  await secureDirectory(directory);
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
