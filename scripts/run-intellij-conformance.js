const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { gradleWrapperInvocation } = require('./intellij-gradle-wrapper');
const { java21ProcessEnvironment, resolveJava21Home } = require('./intellij-java-home');

const repositoryRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repositoryRoot, 'apps', 'intellij-plugin');
const javaHome = resolveJava21Home();
const invocation = gradleWrapperInvocation({
  gradleArgs: ['--no-daemon', 'test', '--tests', '*ApexLogViewerConformanceTest'],
  javaHome,
  pluginRoot
});

console.log(`Using Java 21 from ${javaHome}`);
execFileSync(invocation.command, invocation.args, {
  cwd: pluginRoot,
  env: java21ProcessEnvironment(javaHome),
  stdio: 'inherit'
});
