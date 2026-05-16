import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const VSCE_SHOW_MAX_BUFFER = 32 * 1024 * 1024;

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!match) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function normalizePrereleaseMinor(minor) {
  return minor % 2 === 0 ? minor + 1 : minor;
}

function isVscePrerelease(entry) {
  return (
    Array.isArray(entry?.properties) &&
    entry.properties.some(
      property =>
        property?.key === 'Microsoft.VisualStudio.Code.PreRelease' &&
        String(property?.value) === 'true'
    )
  );
}

function isOpenVsxPrerelease(entry) {
  return entry?.preRelease === true;
}

function formatSpawnError(prefix, result) {
  const details = [result.stdout, result.stderr]
    .filter(value => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .trim();
  return details ? `${prefix}\n${details}` : prefix;
}

export function readExtensionManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (!manifest.publisher || !manifest.name || !manifest.version) {
    throw new Error(`expected ${manifestPath} to declare publisher, name, and version`);
  }

  return {
    baseVersion: manifest.version,
    extensionId: `${manifest.publisher}.${manifest.name}`
  };
}

export function findLatestPublishedPrereleasePatch(marketplaceVersions, { major, minor }) {
  let latestPatch = -1;

  for (const entry of marketplaceVersions) {
    const parsed = parseSemver(entry?.version);
    if (!parsed) {
      continue;
    }

    const isPrerelease = isVscePrerelease(entry) || isOpenVsxPrerelease(entry);
    if (!isPrerelease) {
      continue;
    }

    if (parsed.major === major && parsed.minor === minor && parsed.patch > latestPatch) {
      latestPatch = parsed.patch;
    }
  }

  return latestPatch;
}

export function computeNextPrereleaseVersion({ baseVersion, marketplaceVersions }) {
  const parsedBase = parseSemver(baseVersion);
  if (!parsedBase) {
    throw new Error(`expected a plain semver extension version, got ${JSON.stringify(baseVersion)}`);
  }

  const targetMinor = normalizePrereleaseMinor(parsedBase.minor);
  const latestPublishedPatch = findLatestPublishedPrereleasePatch(marketplaceVersions, {
    major: parsedBase.major,
    minor: targetMinor
  });
  const nextPatch = Math.min(Math.max(parsedBase.patch, latestPublishedPatch) + 1, 2147483647);

  return `${parsedBase.major}.${targetMinor}.${nextPatch}`;
}

export function resolveVsceCliPath() {
  return require.resolve('@vscode/vsce/vsce');
}

export function fetchMarketplaceVersions(
  extensionId,
  {
    spawnSyncImpl = spawnSync,
    vsceCliPath = resolveVsceCliPath(),
    processExecPath = process.execPath,
    cwd = process.cwd()
  } = {}
) {
  const result = spawnSyncImpl(
    processExecPath,
    [vsceCliPath, 'show', extensionId, '--json'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: VSCE_SHOW_MAX_BUFFER
    }
  );

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error(
      formatSpawnError(
        `vsce show failed for ${extensionId} with exit code ${result.status ?? 'null'}`,
        result
      )
    );
  }

  const payload = JSON.parse(String(result.stdout ?? '{}'));
  return Array.isArray(payload.versions) ? payload.versions : [];
}

export function openVsxApiUrlForExtension(extensionId) {
  const separatorIndex = String(extensionId).indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === String(extensionId).length - 1) {
    throw new Error(`expected extension id in publisher.name form, got ${JSON.stringify(extensionId)}`);
  }
  const namespace = encodeURIComponent(String(extensionId).slice(0, separatorIndex));
  const name = encodeURIComponent(String(extensionId).slice(separatorIndex + 1));
  return `https://open-vsx.org/api/${namespace}/${name}`;
}

export function versionsFromOpenVsxPayload(payload) {
  const versions = new Set();
  if (payload?.allVersions && typeof payload.allVersions === 'object') {
    for (const version of Object.keys(payload.allVersions)) {
      versions.add(version);
    }
  }
  if (typeof payload?.version === 'string' && payload.version.trim()) {
    versions.add(payload.version.trim());
  }

  return Array.from(versions).map(version => {
    const parsed = parseSemver(version);
    return {
      version,
      preRelease: parsed ? parsed.minor % 2 === 1 : false,
      source: 'open-vsx'
    };
  });
}

export async function fetchOpenVsxVersions(
  extensionId,
  {
    fetchImpl = globalThis.fetch
  } = {}
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable; cannot query Open VSX versions');
  }

  const url = openVsxApiUrlForExtension(extensionId);
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Open VSX version query failed for ${extensionId}: HTTP ${response.status}`);
  }

  return versionsFromOpenVsxPayload(await response.json());
}

function parseArgs(argv) {
  const options = {
    manifestPath: 'apps/vscode-extension/package.json'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    switch (arg) {
      case '--manifest':
        if (!value) {
          throw new Error('missing value for --manifest');
        }
        options.manifestPath = value;
        index += 1;
        break;
      default:
        throw new Error(`unexpected argument: ${arg}`);
    }
  }

  return options;
}

export async function main(
  argv = process.argv.slice(2),
  {
    cwd = process.cwd(),
    stdout = process.stdout,
    spawnSyncImpl = spawnSync,
    vsceCliPath,
    processExecPath = process.execPath,
    fetchImpl = globalThis.fetch
  } = {}
) {
  const { manifestPath } = parseArgs(argv);
  const resolvedManifestPath = path.resolve(cwd, manifestPath);
  const { baseVersion, extensionId } = readExtensionManifest(resolvedManifestPath);
  const marketplaceVersions = fetchMarketplaceVersions(extensionId, {
    spawnSyncImpl,
    vsceCliPath,
    processExecPath,
    cwd
  });
  const openVsxVersions = await fetchOpenVsxVersions(extensionId, { fetchImpl });
  const nextVersion = computeNextPrereleaseVersion({
    baseVersion,
    marketplaceVersions: [...marketplaceVersions, ...openVsxVersions]
  });

  stdout.write(nextVersion);
  return nextVersion;
}

export function isDirectExecution(argvEntry, moduleUrl = import.meta.url) {
  return Boolean(argvEntry) && path.resolve(argvEntry) === fileURLToPath(moduleUrl);
}

if (isDirectExecution(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
