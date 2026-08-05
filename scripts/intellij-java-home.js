const { spawnSync } = require('node:child_process');
const path = require('node:path');

const JAVA_21_ENV_KEYS = [
  'JAVA_HOME_21_X64',
  'JAVA_HOME_21_ARM64',
  'JAVA_21_HOME',
  'JDK_21_HOME',
  'JDK21_HOME',
  'JAVA_HOME'
];

function normalizedHome(candidate) {
  const value = String(candidate || '').trim();
  return value.replace(/^"|"$/g, '');
}

function javaTool(javaHome, tool, platform = process.platform) {
  return path.join(javaHome, 'bin', `${tool}${platform === 'win32' ? '.exe' : ''}`);
}

function java21ProcessEnvironment(javaHome, env = process.env) {
  return { ...env, JAVA_HOME: javaHome };
}

function parseJavaMajorVersion(output) {
  const match = String(output).match(/(?:openjdk|java) version "(?:1\.)?(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function isJava21Home(javaHome, platform = process.platform) {
  if (!javaHome) {
    return false;
  }

  const result = spawnSync(javaTool(javaHome, 'java', platform), ['-version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return !result.error && result.status === 0 && parseJavaMajorVersion(output) === 21;
}

function findScoopJava21Home(env = process.env) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'scoop prefix temurin21-jdk'],
    {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );

  if (result.error || result.status !== 0) {
    return undefined;
  }

  return normalizedHome(
    String(result.stdout || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .at(-1)
  );
}

function resolveJava21Home({
  env = process.env,
  platform = process.platform,
  findScoopJava21Home: scoopResolver = findScoopJava21Home,
  isJava21Home: validator = candidate => isJava21Home(candidate, platform)
} = {}) {
  const candidates = JAVA_21_ENV_KEYS.map(key => normalizedHome(env[key])).filter(Boolean);

  if (platform === 'win32') {
    const scoopHome = normalizedHome(scoopResolver(env));
    if (scoopHome) {
      candidates.push(scoopHome);
    }
  }

  const checked = [];
  for (const candidate of candidates) {
    if (checked.includes(candidate)) {
      continue;
    }
    checked.push(candidate);
    if (validator(candidate)) {
      return candidate;
    }
  }

  const checkedMessage = checked.length > 0 ? ` Checked: ${checked.join(', ')}.` : '';
  throw new Error(
    'Java 21 is required to test the IntelliJ plugin. Configure JAVA_HOME_21_X64, JAVA_21_HOME, ' +
      `JDK_21_HOME, or JAVA_HOME to a JDK 21 installation.${checkedMessage}`
  );
}

module.exports = {
  java21ProcessEnvironment,
  javaTool,
  parseJavaMajorVersion,
  resolveJava21Home
};
