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

test('allows registry tarballs, workspace links, and the approved pinned git lock entry', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-deps-'));

  try {
    writeJson(tempDir, 'package.json', {
      name: 'fixture',
      private: true,
      workspaces: ['packages/*'],
      dependencies: {
        leftpad: '^1.0.0',
        'tree-sitter-sfapex':
          'git+https://github.com/manoelcalixto/tree-sitter-sfapex.git#685c57c5461eb247d019b244f2130e198c7cc706'
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
            leftpad: '^1.0.0',
            'tree-sitter-sfapex':
              'git+https://github.com/manoelcalixto/tree-sitter-sfapex.git#685c57c5461eb247d019b244f2130e198c7cc706'
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
        },
        'node_modules/tree-sitter-sfapex': {
          version: '2.4.1',
          resolved:
            'git+ssh://git@github.com/manoelcalixto/tree-sitter-sfapex.git#685c57c5461eb247d019b244f2130e198c7cc706',
          integrity: 'sha512-pinned-git'
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
    assert.match(result.stderr, /package-lock\.json -> node_modules\/leftpad -> https:\/\/evil\.example\/leftpad-1\.0\.0\.tgz/);
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
