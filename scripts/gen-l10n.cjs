/* Generates VS Code l10n runtime bundles from legacy localize(key, message) calls. */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const repoRoot = path.join(__dirname, '..');
const runtimeSourceRoots = [path.join(repoRoot, 'apps', 'vscode-extension', 'src')];
const l10nDir = path.join(repoRoot, 'apps', 'vscode-extension', 'l10n');
const baseFile = path.join(l10nDir, 'bundle.l10n.json');
const ptBrFile = path.join(l10nDir, 'bundle.l10n.pt-br.json');

const ptBrByLegacyKey = {
  openError: 'Falha ao abrir o log: ',
  replayError: 'Falha ao iniciar o Apex Replay Debugger: ',
  replayStarting: 'Iniciando o Apex Replay Debugger...',
  replayCommandsUnavailableMessage:
    'Apex Replay Debugger está instalado ({0}), mas seus comandos não estão disponíveis. Garanta que esteja habilitado neste ambiente do VS Code (Local/WSL/SSH/Dev Containers), recarregue a janela e tente novamente.',
  replayMissingExtMessage:
    'Apex Replay Debugger não está disponível. Instale o Salesforce Extension Pack (salesforce.salesforcedx-vscode) ou a extensão avulsa Apex Replay Debugger ({0}) e garanta que esteja habilitado neste ambiente do VS Code (Local/WSL/SSH/Dev Containers).',
  tailSelectDebugLevel: 'Selecione um nível de depuração',
  tailHardStop: 'Tail parado após 30 minutos.',
  tailSavedTo: 'Salvo em {0}',
  tailSaveFailed: 'Tail: falha ao salvar log no workspace (melhor esforço).',
  cliNotFound: 'Salesforce CLI não encontrada. Instale o Salesforce CLI (sf).',
  cliTimeout: 'Comando do Salesforce CLI expirou após {0} segundos: {1}',
  cliAuthFailed:
    'Não foi possível obter credenciais via Salesforce CLI. Verifique a autenticação e tente: sf org auth show-access-token --json --no-prompt',
  selectOrgPlaceholder: 'Selecione uma org autenticada',
  selectOrgDefault: 'Padrão',
  selectOrgError: 'Electivus Apex Logs: falha ao listar orgs',
  refreshingLogs: 'Atualizando logs...',
  listingOrgs: 'Listando orgs Salesforce...',
  'salesforce.logs.view.name': 'Electivus Apex Logs',
  'salesforce.tail.view.name': 'Electivus Apex Logs Tail'
};

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function collectTypeScriptFiles(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'test' && entry.name !== 'node-test') {
        collectTypeScriptFiles(entryPath, files);
      }
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

function getStringLiteralText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function formatLocation(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.relative(repoRoot, sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

function extractMessagesFromFile(file) {
  const contents = fs.readFileSync(file, 'utf8');
  if (!contents.includes('localize(')) {
    return [];
  }

  const sourceFile = ts.createSourceFile(
    file,
    contents,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const messages = [];

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'localize') {
      const [legacyKeyArg, defaultMessageArg] = node.arguments;
      const legacyKey = legacyKeyArg ? getStringLiteralText(legacyKeyArg) : undefined;
      const defaultMessage = defaultMessageArg ? getStringLiteralText(defaultMessageArg) : undefined;
      if (!legacyKey || !defaultMessage) {
        throw new Error(
          `localize calls must use literal key and message arguments: ${formatLocation(sourceFile, node)}`
        );
      }
      messages.push({ legacyKey, defaultMessage, location: formatLocation(sourceFile, node) });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return messages;
}

function collectMessages() {
  const byMessage = new Map();
  const byLegacyKey = new Map();
  const files = runtimeSourceRoots.flatMap(root => collectTypeScriptFiles(root)).sort();

  for (const file of files) {
    for (const message of extractMessagesFromFile(file)) {
      const existingForKey = byLegacyKey.get(message.legacyKey);
      if (existingForKey && existingForKey.defaultMessage !== message.defaultMessage) {
        throw new Error(
          `localize key '${message.legacyKey}' has multiple default messages:\n` +
            `  ${existingForKey.location}: ${existingForKey.defaultMessage}\n` +
            `  ${message.location}: ${message.defaultMessage}`
        );
      }
      byLegacyKey.set(message.legacyKey, message);
      if (!byMessage.has(message.defaultMessage)) {
        byMessage.set(message.defaultMessage, message);
      }
    }
  }

  return Array.from(byMessage.values()).sort((a, b) => a.defaultMessage.localeCompare(b.defaultMessage));
}

const messages = collectMessages();
const baseBundle = Object.fromEntries(messages.map(({ defaultMessage }) => [defaultMessage, defaultMessage]));
const existingPtBrBundle = readJsonIfExists(ptBrFile);
const ptBrBundle = {};

for (const { legacyKey, defaultMessage } of messages) {
  const translated = ptBrByLegacyKey[legacyKey] || existingPtBrBundle[defaultMessage];
  if (translated && translated !== defaultMessage) {
    ptBrBundle[defaultMessage] = translated;
  }
}

writeJson(baseFile, baseBundle);
writeJson(ptBrFile, ptBrBundle);

console.log(`[l10n] wrote ${messages.length} runtime message(s) to apps/vscode-extension/l10n/bundle.l10n*.json`);
