const path = require('node:path');

const { javaTool } = require('./intellij-java-home');

function gradleWrapperInvocation({ gradleArgs, javaHome, pluginRoot }) {
  return {
    command: javaTool(javaHome, 'java'),
    args: [
      '-Dorg.gradle.appname=gradlew',
      '-classpath',
      path.join(pluginRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
      'org.gradle.wrapper.GradleWrapperMain',
      ...gradleArgs
    ]
  };
}

module.exports = { gradleWrapperInvocation };
