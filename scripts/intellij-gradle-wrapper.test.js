const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { gradleWrapperInvocation } = require('./intellij-gradle-wrapper');

test('gradleWrapperInvocation keeps uncontrolled absolute paths out of a shell command', () => {
  const filesystemRoot = path.parse(process.cwd()).root;
  const pluginRoot = path.join(filesystemRoot, 'workspace & echo injected', 'intellij-plugin');
  const javaHome = path.join(filesystemRoot, 'jdk 21 & echo injected');
  const gradleArgs = ['--no-daemon', 'clean', 'test'];

  const invocation = gradleWrapperInvocation({ gradleArgs, javaHome, pluginRoot });

  assert.equal(invocation.command, path.join(javaHome, 'bin', `java${process.platform === 'win32' ? '.exe' : ''}`));
  assert.deepEqual(invocation.args, [
    '-Dorg.gradle.appname=gradlew',
    '-classpath',
    path.join(pluginRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
    'org.gradle.wrapper.GradleWrapperMain',
    ...gradleArgs
  ]);
  assert.equal(Object.hasOwn(invocation, 'shell'), false);
  assert.doesNotMatch(invocation.command, /(?:cmd|powershell)(?:\.exe)?$/i);
});
