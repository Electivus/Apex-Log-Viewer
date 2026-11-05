const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-dependency-sources.mjs');

function writeJson(baseDir, relativePath, value) {
  const filePath = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function runCheck(baseDir) {
  return spawnSync(process.execPath, [scriptPath, '--root', baseDir], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
}

function runCheckWithScript(scriptFilePath, baseDir) {
  return spawnSync(process.execPath, [scriptFilePath, '--root', baseDir], {
    cwd: baseDir,
    encoding: 'utf8'
  });
}

test('allows registry tarballs and workspace links', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      workspaces: ['packages/*'],
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'packages/example/package.json', {
      name: '@alv/example',
      version: '1.0.0'
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          workspaces: ['packages/*'],
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
          integrity: 'sha512-registry'
        },
        'node_modules/@alv/example': {
          resolved: 'packages/example',
          link: true
        }
      }
    });

    const result = runCheck(tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects non-registry lockfile resolved URLs even when manifests stay registry-only', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://evil.example/leftpad-1.0.0.tgz',
          integrity: 'sha512-evil'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected lockfile provenance check to fail');
    assert.match(
      result.stderr,
      /package-lock\.json -> node_modules\/leftpad -> https:\/\/evil\.example\/leftpad-1\.0\.0\.tgz/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects legacy lockfile dependency resolved URLs when packages metadata is absent', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 2,
      requires: true,
      dependencies: {
        leftpad: {
          version: '1.0.0',
          resolved: 'https://evil.example/leftpad-1.0.0.tgz',
          integrity: 'sha512-evil'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected legacy lockfile provenance check to fail');
    assert.match(result.stderr, /package-lock\.json -> leftpad -> https:\/\/evil\.example\/leftpad-1\.0\.0\.tgz/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects legacy lockfile dependency version URLs when resolved is absent', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 2,
      requires: true,
      dependencies: {
        leftpad: {
          version: 'https://evil.example/leftpad-1.0.0.tgz',
          integrity: 'sha512-evil'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected legacy lockfile version source check to fail');
    assert.match(result.stderr, /package-lock\.json -> leftpad -> https:\/\/evil\.example\/leftpad-1\.0\.0\.tgz/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects lockfile links that target in-repo paths outside declared workspaces', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      workspaces: ['packages/*'],
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'vendor/evil/package.json', {
      name: 'leftpad',
      version: '1.0.0'
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          workspaces: ['packages/*'],
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          resolved: 'vendor/evil',
          link: true
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected non-workspace link target to fail provenance checks');
    assert.match(result.stderr, /package-lock\.json -> node_modules\/leftpad -> vendor\/evil/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects manifest dependency sources with leading whitespace', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '  git+https://evil.example/leftpad.git#deadbeef'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
          integrity: 'sha512-registry'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected whitespace-prefixed manifest source to fail provenance checks');
    assert.match(result.stderr, /package\.json -> leftpad@git\+https:\/\/evil\.example\/leftpad\.git#deadbeef/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects npm alias manifest dependency sources that target remote specs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: 'npm:evil-pkg@git+https://evil.example/evil.git#deadbeef'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
          integrity: 'sha512-registry'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected remote npm alias manifest source to fail provenance checks');
    assert.match(
      result.stderr,
      /package\.json -> leftpad@npm:evil-pkg@git\+https:\/\/evil\.example\/evil\.git#deadbeef/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects manifest dependency sources in workspaces outside apps and packages', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      workspaces: ['tools/*']
    });
    writeJson(tempDir, 'tools/cli/package.json', {
      name: '@alv/cli',
      version: '1.0.0',
      dependencies: {
        leftpad: 'git+https://evil.example/leftpad.git#deadbeef'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          workspaces: ['tools/*']
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected out-of-tree workspace manifest source to fail provenance checks');
    assert.match(
      result.stderr,
      /tools[\\/]cli[\\/]package\.json -> leftpad@git\+https:\/\/evil\.example\/leftpad\.git#deadbeef/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects peer dependency sources that resolve to git remotes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      peerDependencies: {
        leftpad: 'git+https://evil.example/leftpad.git#deadbeef'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          peerDependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
          integrity: 'sha512-registry'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected peer dependency source to fail provenance checks');
    assert.match(result.stderr, /package\.json -> leftpad@git\+https:\/\/evil\.example\/leftpad\.git#deadbeef/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects shrinkwrap sources in workspaces outside apps and packages', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      workspaces: ['tools/*']
    });
    writeJson(tempDir, 'tools/cli/package.json', {
      name: '@alv/cli',
      version: '1.0.0'
    });
    writeJson(tempDir, 'tools/cli/npm-shrinkwrap.json', {
      name: '@alv/cli',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: '@alv/cli',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://evil.example/leftpad-1.0.0.tgz',
          integrity: 'sha512-evil'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected out-of-tree workspace shrinkwrap to fail provenance checks');
    assert.match(
      result.stderr,
      /tools[\\/]cli[\\/]npm-shrinkwrap\.json -> node_modules\/leftpad -> https:\/\/evil\.example\/leftpad-1\.0\.0\.tgz/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects lockfile npm alias version sources when resolved is absent', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: 'npm:evil-pkg@git+https://evil.example/evil.git#deadbeef'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected lockfile npm alias source to fail provenance checks');
    assert.match(
      result.stderr,
      /package-lock\.json -> node_modules\/leftpad -> npm:evil-pkg@git\+https:\/\/evil\.example\/evil\.git#deadbeef/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects lockfile links whose metadata name spoofs the package path identity', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      workspaces: ['packages/*'],
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'packages/example/package.json', {
      name: '@alv/example',
      version: '1.0.0'
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          workspaces: ['packages/*'],
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          name: '@alv/example',
          resolved: 'packages/example',
          link: true
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected spoofed lockfile package name to fail provenance checks');
    assert.match(result.stderr, /package-lock\.json -> node_modules\/leftpad -> packages\/example/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects disallowed sources from npm-shrinkwrap.json', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'npm-shrinkwrap.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://evil.example/leftpad-1.0.0.tgz',
          integrity: 'sha512-evil'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected npm-shrinkwrap provenance check to fail');
    assert.match(
      result.stderr,
      /npm-shrinkwrap\.json -> node_modules\/leftpad -> https:\/\/evil\.example\/leftpad-1\.0\.0\.tgz/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects manifest git protocol dependency sources', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: 'git://evil.example/leftpad.git#deadbeef'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
          integrity: 'sha512-registry'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected git protocol manifest source to fail provenance checks');
    assert.match(result.stderr, /package\.json -> leftpad@git:\/\/evil\.example\/leftpad\.git#deadbeef/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects lockfile package version URLs when resolved is absent', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: 'git+ssh://git@github.com/evil/leftpad.git#deadbeef'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected packages.version git source to fail provenance checks');
    assert.match(
      result.stderr,
      /package-lock\.json -> node_modules\/leftpad -> git\+ssh:\/\/git@github\.com\/evil\/leftpad\.git#deadbeef/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects lockfile package ssh URLs when resolved is absent', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: '^1.0.0'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: 'ssh://git@github.com/evil/leftpad.git#deadbeef'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected packages.version ssh source to fail provenance checks');
    assert.match(
      result.stderr,
      /package-lock\.json -> node_modules\/leftpad -> ssh:\/\/git@github\.com\/evil\/leftpad\.git#deadbeef/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects hosted git shorthand manifest dependency sources', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: 'npm/cli'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
          integrity: 'sha512-registry'
        }
      }
    });

    const result = runCheck(tempDir);
    assert.notEqual(result.status, 0, 'expected hosted git shorthand to fail provenance checks');
    assert.match(result.stderr, /package\.json -> leftpad@npm\/cli/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runs without installed dependencies while still rejecting hosted git shorthand', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: {
        leftpad: 'npm/cli'
      }
    });
    writeJson(tempDir, 'package-lock.json', {
      name: 'fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          dependencies: {
            leftpad: '^1.0.0'
          }
        },
        'node_modules/leftpad': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
          integrity: 'sha512-registry'
        }
      }
    });

    const isolatedScriptPath = path.join(tempDir, 'scripts', 'check-dependency-sources.mjs');
    fs.mkdirSync(path.dirname(isolatedScriptPath), { recursive: true });
    fs.copyFileSync(scriptPath, isolatedScriptPath);

    const result = runCheckWithScript(isolatedScriptPath, tempDir);
    assert.notEqual(result.status, 0, 'expected hosted git shorthand to fail provenance checks');
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package 'hosted-git-info'/);
    assert.match(result.stderr, /package\.json -> leftpad@npm\/cli/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeText(baseDir, relativePath, value) {
  const filePath = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function pnpmLock({
  deprecated = 'deprecated: Upgrade to 3.30.0',
  resolution = 'resolution: {integrity: sha512-registry}',
  packages = '',
  extra = ''
} = {}) {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '  excludeLinksFromLockfile: false',
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    "      '@alv/example':",
    '        specifier: workspace:*',
    '        version: link:packages/example',
    "      '@smithy/core':",
    '        specifier: ^3.29.1',
    '        version: 3.29.1',
    '',
    '  packages/example: {}',
    '',
    'packages:',
    '',
    "  '@smithy/core@3.29.1':",
    `    ${resolution}`,
    "    engines: {node: '>=18.0.0'}",
    ...(deprecated ? [`    ${deprecated}`] : []),
    '',
    '  tslib@2.8.1:',
    '    resolution: {integrity: sha512-registry}',
    '    os: [darwin, linux]',
    '    bundledDependencies:',
    "      - '@scope/bundled'",
    packages,
    '',
    'snapshots:',
    '',
    "  '@smithy/core@3.29.1':",
    '    dependencies:',
    '      tslib: 2.8.1',
    '',
    '  tslib@2.8.1: {}',
    extra,
    ''
  ].join('\n');
}

function withPnpmFixture(lockfileText, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));
  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      dependencies: { '@smithy/core': '^3.29.1', '@alv/example': 'workspace:*' }
    });
    writeText(tempDir, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    writeJson(tempDir, 'packages/example/package.json', { name: '@alv/example', version: '1.0.0' });
    writeText(tempDir, 'pnpm-lock.yaml', lockfileText);
    return callback(runCheck(tempDir));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function lineOf(text, needle) {
  const index = text.split('\n').findIndex(line => line.includes(needle));
  assert.notEqual(index, -1, `fixture has no line with ${needle}`);
  return index + 1;
}

test('pnpm lockfile: allows a deprecation message with a URL in every scalar style pnpm writes', async t => {
  const styles = {
    plain: 'deprecated: Please upgrade, see https://github.com/aws/aws-sdk-js-v3/issues/8393.',
    'single-quoted': "deprecated: 'Use #2 instead: https://github.com/aws/aws-sdk-js-v3/issues/8393, it''s fixed'",
    'double-quoted':
      'deprecated: "Moved:\\thttps://github.com/aws/aws-sdk-js-v3/issues/8393 \\u2014 git+https://example.com/x.git"',
    'literal block':
      'deprecated: |-\n      Moved to https://github.com/aws/aws-sdk-js-v3/issues/8393\n\n      # not a comment: file:../x',
    'folded block':
      'deprecated: >-\n      See https://github.com/aws/aws-sdk-js-v3/issues/8393\n        and github:aws/aws-sdk-js-v3',
    'block with an indentation indicator':
      'deprecated: |2-\n        Indented: https://github.com/aws/aws-sdk-js-v3/issues/8393\n      next https://example.com/x'
  };
  for (const [style, deprecated] of Object.entries(styles)) {
    await t.test(style, () => {
      withPnpmFixture(pnpmLock({ deprecated }), result => {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      });
    });
  }
});

test('pnpm lockfile: allows a byte order mark and CRLF line endings', () => {
  const text = `\uFEFF${pnpmLock({ deprecated: 'deprecated: see https://example.com/notice' }).replace(/\n/g, '\r\n')}`;
  withPnpmFixture(text, result => {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});

test('pnpm lockfile: rejects dependency sources wherever the lockfile structure can hold one', async t => {
  const cases = {
    'tarball resolution': {
      text: pnpmLock({ resolution: 'resolution: {integrity: sha512-x, tarball: https://evil.example/core.tgz}' }),
      line: 'tarball: https://evil.example/core.tgz',
      source: 'https://evil.example/core.tgz'
    },
    'git resolution': {
      text: pnpmLock({ resolution: 'resolution: {commit: abc123, repo: https://github.com/evil/core.git, type: git}' }),
      line: 'repo: https://github.com/evil/core.git',
      source: 'https://github.com/evil/core.git'
    },
    'snapshot dependency': {
      text: pnpmLock().replace(
        '      tslib: 2.8.1',
        '      tslib: https://codeload.github.com/evil/tslib/tar.gz/abc123'
      ),
      line: 'tslib: https://codeload',
      source: 'https://codeload.github.com/evil/tslib/tar.gz/abc123'
    },
    'importer version': {
      text: pnpmLock().replace(
        '        version: 3.29.1',
        '        version: git+ssh://git@github.com/evil/core.git#abc123'
      ),
      line: 'version: git+ssh',
      source: 'git+ssh://git@github.com/evil/core.git#abc123'
    },
    'package id': {
      text: pnpmLock({
        packages: "\n  'evil@file:../outside':\n    resolution: {directory: ../outside, type: directory}"
      }),
      line: "'evil@file:../outside':",
      source: 'file:../outside'
    },
    override: {
      text: pnpmLock().replace('settings:', 'overrides:\n  tslib: github:evil/tslib\n\nsettings:'),
      line: 'tslib: github:evil/tslib',
      source: 'github:evil/tslib'
    },
    'escaped double-quoted tarball': {
      text: pnpmLock({ resolution: 'resolution: {integrity: sha512-x, tarball: "\\x68ttps://evil.example/core.tgz"}' }),
      line: 'tarball: "\\x68ttps',
      source: 'https://evil.example/core.tgz'
    },
    'block scalar outside a deprecation message': {
      text: pnpmLock({ deprecated: 'notice: |-\n      fetch from https://evil.example/core.tgz' }),
      line: 'fetch from https://evil.example/core.tgz',
      source: 'https://evil.example/core.tgz'
    },
    'deprecated key outside packages': {
      text: pnpmLock().replace('  tslib@2.8.1: {}', '  tslib@2.8.1:\n    deprecated: https://evil.example/tslib.tgz'),
      line: 'deprecated: https://evil.example/tslib.tgz',
      source: 'https://evil.example/tslib.tgz'
    },
    'deprecated key below a package field': {
      text: pnpmLock({
        resolution: 'resolution:\n      deprecated: https://evil.example/core.tgz\n      integrity: sha512-x'
      }),
      line: 'deprecated: https://evil.example/core.tgz',
      source: 'https://evil.example/core.tgz'
    },
    'deprecated key in a flow mapping': {
      text: pnpmLock({ packages: "\n  evil@1.0.0: {deprecated: 'https://evil.example/evil.tgz'}" }),
      line: 'evil@1.0.0: {deprecated',
      source: 'https://evil.example/evil.tgz'
    },
    'second YAML document': {
      text: `${pnpmLock()}---\nimporters:\n  .:\n    configDependencies:\n      evil:\n        specifier: https://evil.example/evil.tgz\n        version: 1.0.0\n`,
      line: 'specifier: https://evil.example/evil.tgz',
      source: 'https://evil.example/evil.tgz'
    }
  };
  for (const [name, { text, line, source }] of Object.entries(cases)) {
    await t.test(name, () => {
      withPnpmFixture(text, result => {
        assert.notEqual(result.status, 0, 'expected the dependency source check to fail');
        assert.ok(
          result.stderr.includes(`pnpm-lock.yaml:${lineOf(text, line)} -> ${source}`),
          `expected pnpm-lock.yaml:${lineOf(text, line)} -> ${source} in:\n${result.stderr}`
        );
      });
    });
  }
});

test('pnpm lockfile: a deprecation message cannot hide a source on the lines after it', async t => {
  const evilResolution = 'resolution: {integrity: sha512-x, tarball: https://evil.example/core.tgz}';
  const cases = {
    'lone carriage return': {
      deprecated: `deprecated: see https://example.com/notice\r    ${evilResolution}`,
      expected: /unsupported YAML \(unsupported character U\+000D\)/
    },
    'more-indented continuation line': {
      deprecated: `deprecated: see the notice\n      ${evilResolution}`,
      expected: /unsupported YAML \(unexpected indentation\)/
    },
    'multi-line single-quoted message': {
      deprecated: `deprecated: 'see the notice\n      ${evilResolution}'`,
      expected: /unsupported YAML \(multi-line or unterminated quoted scalar\)/
    },
    'multi-line double-quoted message': {
      deprecated: `deprecated: "see the notice\\\n      ${evilResolution}"`,
      expected: /unsupported YAML \(multi-line double-quoted scalar\)/
    },
    'line under a block message indented less than its content': {
      deprecated: `deprecated: |-\n        see the notice\n      ${evilResolution}`,
      expected: /unsupported YAML \(unexpected indentation\)/
    },
    'block message followed by a real resolution': {
      deprecated: `deprecated: |-\n      see https://example.com/notice\n    tarball-note: https://evil.example/core.tgz`,
      expected: /pnpm-lock\.yaml:\d+ -> https:\/\/evil\.example\/core\.tgz/
    },
    'comment after a message': {
      deprecated: `deprecated: see the notice # ${evilResolution}`,
      expected: /unsupported YAML \(comment\)/
    },
    'tab-indented line': {
      deprecated: `deprecated: see the notice\n\t${evilResolution}`,
      expected: /unsupported YAML \(unsupported character U\+0009\)/
    },
    'line separator': {
      deprecated: `deprecated: see the notice\u2028    ${evilResolution}`,
      expected: /unsupported YAML \(unsupported character U\+2028\)/
    }
  };
  for (const [name, { deprecated, expected }] of Object.entries(cases)) {
    await t.test(name, () => {
      withPnpmFixture(pnpmLock({ deprecated }), result => {
        assert.notEqual(result.status, 0, 'expected the dependency source check to fail');
        assert.match(result.stderr, expected);
      });
    });
  }
});

test('pnpm lockfile: fails closed on YAML that pnpm does not write', async t => {
  const cases = {
    'full-line comment': ['  # comment\n  tslib@2.8.1:', /\(comment\)/],
    anchor: ['  tslib@2.8.1: &shared', /\(plain scalar starts with indicator &\)/],
    alias: ['  tslib@2.8.1: *shared', /\(plain scalar starts with indicator \*\)/],
    tag: ['  tslib@2.8.1: !!map {}', /\(plain scalar starts with indicator !\)/],
    'merge key': ['  tslib@2.8.1:\n    <<: {dependencies: {}}', /\(merge key\)/],
    'complex key': ['  ? tslib@2.8.1\n  : {}', /\(complex mapping key\)/],
    'block scalar header with a comment': [
      '  tslib@2.8.1:\n    notice: |- # note\n      text',
      /\(unsupported block scalar header\)/
    ],
    'multi-line flow mapping': [
      '  tslib@2.8.1: {dependencies: {},\n    optional: true}',
      /\(multi-line or malformed flow mapping\)/
    ],
    'document end marker': ['...\n  tslib@2.8.1:', /\(unsupported document marker or directive\)/]
  };
  for (const [name, [replacement, expected]] of Object.entries(cases)) {
    await t.test(name, () => {
      const text = pnpmLock().replace('  tslib@2.8.1: {}', replacement);
      withPnpmFixture(text, result => {
        assert.notEqual(result.status, 0, 'expected the dependency source check to fail');
        assert.match(result.stderr, /pnpm-lock\.yaml:\d+ -> unsupported YAML/);
        assert.match(result.stderr, expected);
      });
    });
  }

  await t.test('duplicate key', () => {
    const text = pnpmLock().replace(
      "    engines: {node: '>=18.0.0'}",
      "    engines: {node: '>=18.0.0'}\n    resolution: {integrity: sha512-y}"
    );
    withPnpmFixture(text, result => {
      assert.notEqual(result.status, 0, 'expected the dependency source check to fail');
      assert.match(result.stderr, /unsupported YAML \(duplicate key resolution\)/);
    });
  });
});

test('pnpm lockfile: rejects importer links that do not name the workspace package they target', () => {
  const text = pnpmLock().replace('        version: link:packages/example', '        version: link:packages/other');
  withPnpmFixture(text, result => {
    assert.notEqual(result.status, 0, 'expected the dependency source check to fail');
    assert.ok(
      result.stderr.includes(
        `pnpm-lock.yaml:${lineOf(text, 'version: link:packages/other')} -> @alv/example -> link:packages/other`
      ),
      result.stderr
    );
  });
});
