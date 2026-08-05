const assert = require('node:assert/strict');
const test = require('node:test');

const { java21ProcessEnvironment, resolveJava21Home } = require('./intellij-java-home');

test('java21ProcessEnvironment preserves an explicitly configured Gradle user home', () => {
  const environment = java21ProcessEnvironment('/opt/java/21', {
    GRADLE_USER_HOME: '/opt/gradle-cache',
    PATH: '/usr/bin'
  });

  assert.equal(environment.JAVA_HOME, '/opt/java/21');
  assert.equal(environment.GRADLE_USER_HOME, '/opt/gradle-cache');
  assert.equal(environment.PATH, '/usr/bin');
});

test('java21ProcessEnvironment leaves the Gradle user home unset so Gradle uses its default', () => {
  const environment = java21ProcessEnvironment('/opt/java/21', { PATH: '/usr/bin' });

  assert.equal(environment.JAVA_HOME, '/opt/java/21');
  assert.equal(Object.hasOwn(environment, 'GRADLE_USER_HOME'), false);
});

test('resolveJava21Home prefers a CI-provided Java 21 home over an incompatible ambient JAVA_HOME', () => {
  const checked = [];
  const java21Home = '/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21/x64';

  const resolved = resolveJava21Home({
    env: {
      JAVA_HOME: '/opt/java/25',
      JAVA_HOME_21_X64: java21Home
    },
    isJava21Home(candidate) {
      checked.push(candidate);
      return candidate === java21Home;
    },
    platform: 'linux'
  });

  assert.equal(resolved, java21Home);
  assert.deepEqual(checked, [java21Home]);
});

test('resolveJava21Home uses Scoop discovery on Windows when ambient JAVA_HOME is incompatible', () => {
  const ambientHome = 'C:\\Java\\temurin-25';
  const scoopHome = 'C:\\Users\\example\\scoop\\apps\\temurin21-jdk\\current';

  const resolved = resolveJava21Home({
    env: { JAVA_HOME: ambientHome },
    findScoopJava21Home: () => scoopHome,
    isJava21Home: candidate => candidate === scoopHome,
    platform: 'win32'
  });

  assert.equal(resolved, scoopHome);
});

test('resolveJava21Home reports the supported configuration when Java 21 cannot be found', () => {
  assert.throws(
    () =>
      resolveJava21Home({
        env: { JAVA_HOME: '/opt/java/25' },
        isJava21Home: () => false,
        platform: 'linux'
      }),
    /Java 21 is required[\s\S]*JAVA_HOME_21_X64[\s\S]*JAVA_HOME/
  );
});
