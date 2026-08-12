const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { gradleWrapperInvocation } = require('./intellij-gradle-wrapper');
const { java21ProcessEnvironment, javaTool, resolveJava21Home } = require('./intellij-java-home');

const repositoryRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repositoryRoot, 'apps', 'intellij-plugin');

function extractArchive(archive, destination, javaHome) {
  fs.mkdirSync(destination, { recursive: true });
  execFileSync(javaTool(javaHome, 'jar'), ['xf', archive], {
    cwd: destination,
    stdio: 'pipe'
  });
}

function testAndBuildPlugin(javaHome) {
  const invocation = gradleWrapperInvocation({
    gradleArgs: ['--no-daemon', 'clean', 'test', 'buildPlugin'],
    javaHome,
    pluginRoot
  });

  execFileSync(invocation.command, invocation.args, {
    cwd: pluginRoot,
    env: java21ProcessEnvironment(javaHome),
    stdio: 'inherit'
  });
}

test(
  'Gradle builds an installable IntelliJ plugin with the supported identity and compatibility',
  { timeout: 30 * 60 * 1000 },
  () => {
    const wrapper = path.join(pluginRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const wrapperJar = path.join(pluginRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
    assert.ok(fs.existsSync(wrapper), 'the checked-in Gradle wrapper must exist');
    assert.ok(fs.existsSync(wrapperJar), 'the checked-in Gradle wrapper JAR must exist');
    const javaHome = resolveJava21Home();
    console.log(`Using Java 21 from ${javaHome}`);

    testAndBuildPlugin(javaHome);

    const buildScript = fs.readFileSync(path.join(pluginRoot, 'build.gradle.kts'), 'utf8');
    const version = /^version = "([^"]+)"$/m.exec(buildScript)?.[1];
    assert.ok(version, 'the Gradle plugin version must be declared');
    const distributions = path.join(pluginRoot, 'build', 'distributions');
    const zipNames = fs.readdirSync(distributions).filter(name => name.endsWith('.zip'));
    assert.deepEqual(zipNames, [`electivus-apex-log-viewer-${version}.zip`]);

    const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-intellij-artifact-'));
    try {
      extractArchive(path.join(distributions, zipNames[0]), extractionRoot, javaHome);

      const pluginDirectory = path.join(extractionRoot, 'electivus-apex-log-viewer');
      const libraryDirectory = path.join(pluginDirectory, 'lib');
      const pluginJars = fs.readdirSync(libraryDirectory).filter(name => name.endsWith('.jar'));
      assert.deepEqual(pluginJars, [`electivus-apex-log-viewer-${version}.jar`]);

      const jarRoot = path.join(extractionRoot, 'jar');
      extractArchive(path.join(libraryDirectory, pluginJars[0]), jarRoot, javaHome);
      const pluginXml = fs.readFileSync(path.join(jarRoot, 'META-INF', 'plugin.xml'), 'utf8');

      assert.ok(
        fs.existsSync(
          path.join(jarRoot, 'com', 'electivus', 'apexlogviewer', 'ui', 'ApexLogViewerToolWindowFactory.class')
        ),
        'the registered factory must be present in the packaged plugin'
      );

      assert.match(pluginXml, /<id>com\.electivus\.apexlogviewer<\/id>/);
      assert.match(pluginXml, /<name>Electivus Apex Log Viewer<\/name>/);
      assert.match(pluginXml, /<vendor url="https:\/\/github\.com\/Electivus\/Apex-Log-Viewer">Electivus<\/vendor>/);
      assert.match(pluginXml, /<change-notes><!\[CDATA\[[\s\S]+Unified Log Search[\s\S]+<\/change-notes>/);
      assert.match(pluginXml, new RegExp(`<version>${version.replaceAll('.', '\\.')}</version>`));
      assert.match(pluginXml, /<idea-version since-build="261" until-build="262\.\*"\s*\/>/);
      assert.match(pluginXml, /<depends>com\.intellij\.modules\.platform<\/depends>/);
      assert.match(pluginXml, /<depends>com\.intellij\.modules\.idea<\/depends>/);
      assert.match(pluginXml, /<resource-bundle>messages\.ApexLogViewerBundle<\/resource-bundle>/);
      assert.match(
        pluginXml,
        /<description><!\[CDATA\[Native IntelliJ IDEA access to the Apex Log Lifecycle\.\]\]><\/description>/
      );
      assert.ok(fs.existsSync(path.join(jarRoot, 'META-INF', 'pluginIcon.svg')), 'the plugin icon must be packaged');
      assert.ok(fs.existsSync(path.join(jarRoot, 'META-INF', 'LICENSE')), 'the plugin license must be packaged');
      for (const policy of ['PRIVACY.md', 'PRIVACY_pt_BR.md', 'SUPPORT.md', 'SUPPORT_pt_BR.md']) {
        assert.ok(fs.existsSync(path.join(jarRoot, 'META-INF', policy)), `${policy} must be packaged`);
      }
      assert.match(fs.readFileSync(path.join(jarRoot, 'META-INF', 'PRIVACY.md'), 'utf8'), /sends no telemetry/i);
      assert.match(
        fs.readFileSync(path.join(jarRoot, 'META-INF', 'SUPPORT.md'), 'utf8'),
        /github\.com\/Electivus\/Apex-Log-Viewer\/issues/
      );

      const englishBundle = fs.readFileSync(path.join(jarRoot, 'messages', 'ApexLogViewerBundle.properties'), 'utf8');
      const brazilianPortugueseBundle = fs.readFileSync(
        path.join(jarRoot, 'messages', 'ApexLogViewerBundle_pt_BR.properties'),
        'utf8'
      );
      assert.doesNotMatch(englishBundle, /^plugin\.com\.electivus\.apexlogviewer\.(?:description|changeNotes)=/m);
      assert.doesNotMatch(
        brazilianPortugueseBundle,
        /^plugin\.com\.electivus\.apexlogviewer\.(?:description|changeNotes)=/m
      );
      assert.match(pluginXml, /<toolWindow[^>]+anchor="bottom"/);
      assert.match(pluginXml, /<toolWindow[^>]+icon="AllIcons\.FileTypes\.Text"/);
      assert.match(
        pluginXml,
        /<toolWindow[^>]+id="Electivus Apex Log Viewer"[^>]+factoryClass="com\.electivus\.apexlogviewer\.ui\.ApexLogViewerToolWindowFactory"/
      );
      assert.doesNotMatch(pluginXml, /(?:text|description)="%action\./);
      assert.match(englishBundle, /^action\.ApexLogViewer\.RefreshLogs\.text=Refresh Apex Logs$/m);
      assert.match(
        brazilianPortugueseBundle,
        /^action\.ApexLogViewer\.RefreshLogs\.text=Atualizar logs do Apex$/m
      );
      assert.equal(
        [...pluginXml.matchAll(/<action\b[^>]+icon="AllIcons\.Actions\.[^"]+"/g)].length,
        11,
        'all registered actions must package native IntelliJ icons'
      );

      const packagedFiles = fs
        .readdirSync(pluginDirectory, { recursive: true })
        .map(entry => String(entry).replaceAll('\\\\', '/'));
      assert.equal(
        packagedFiles.some(entry => /\.(?:html|js|jsx|ts|tsx)$/i.test(entry)),
        false
      );
    } finally {
      fs.rmSync(extractionRoot, { recursive: true, force: true });
    }
  }
);
