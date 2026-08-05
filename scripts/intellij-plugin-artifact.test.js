const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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

function testAndBuildPlugin(wrapper, javaHome) {
  const args = ['--no-daemon', 'clean', 'test', 'buildPlugin'];
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : wrapper;
  const commandArgs = process.platform === 'win32' ? ['/d', '/c', wrapper, ...args] : args;

  execFileSync(command, commandArgs, {
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
    assert.ok(fs.existsSync(wrapper), 'the checked-in Gradle wrapper must exist');
    const javaHome = resolveJava21Home();
    console.log(`Using Java 21 from ${javaHome}`);

    testAndBuildPlugin(wrapper, javaHome);

    const distributions = path.join(pluginRoot, 'build', 'distributions');
    const zipNames = fs.readdirSync(distributions).filter(name => name.endsWith('.zip'));
    assert.deepEqual(zipNames, ['electivus-apex-log-viewer-0.1.0.zip']);

    const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alv-intellij-artifact-'));
    try {
      extractArchive(path.join(distributions, zipNames[0]), extractionRoot, javaHome);

      const pluginDirectory = path.join(extractionRoot, 'electivus-apex-log-viewer');
      const libraryDirectory = path.join(pluginDirectory, 'lib');
      const pluginJars = fs.readdirSync(libraryDirectory).filter(name => name.endsWith('.jar'));
      assert.deepEqual(pluginJars, ['electivus-apex-log-viewer-0.1.0.jar']);

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
      assert.match(pluginXml, /<vendor>Electivus<\/vendor>/);
      assert.match(pluginXml, /<version>0\.1\.0<\/version>/);
      assert.match(pluginXml, /<idea-version since-build="261" until-build="262\.\*"\s*\/>/);
      assert.match(pluginXml, /<depends>com\.intellij\.modules\.platform<\/depends>/);
      assert.match(pluginXml, /<depends>com\.intellij\.modules\.idea<\/depends>/);
      assert.match(pluginXml, /<resource-bundle>messages\.ApexLogViewerBundle<\/resource-bundle>/);
      assert.doesNotMatch(pluginXml, /<description\b/);
      assert.doesNotMatch(pluginXml, /Native IntelliJ IDEA access to the Apex Log Lifecycle\./);

      const englishBundle = fs.readFileSync(path.join(jarRoot, 'messages', 'ApexLogViewerBundle.properties'), 'utf8');
      const brazilianPortugueseBundle = fs.readFileSync(
        path.join(jarRoot, 'messages', 'ApexLogViewerBundle_pt_BR.properties'),
        'utf8'
      );
      assert.match(
        englishBundle,
        /^plugin\.com\.electivus\.apexlogviewer\.description=Native IntelliJ IDEA access to the Apex Log Lifecycle\.$/m
      );
      assert.match(
        brazilianPortugueseBundle,
        /^plugin\.com\.electivus\.apexlogviewer\.description=Acesso nativo do IntelliJ IDEA ao ciclo de vida de logs do Apex\.$/m
      );
      assert.match(pluginXml, /<toolWindow[^>]+anchor="right"/);
      assert.match(
        pluginXml,
        /<toolWindow[^>]+id="Electivus Apex Log Viewer"[^>]+factoryClass="com\.electivus\.apexlogviewer\.ui\.ApexLogViewerToolWindowFactory"/
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
