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
  'salesforce.tail.view.name': 'Electivus Apex Logs Tail',
  'customLogs.view.name': 'Electivus Logs Personalizados',
  'customLogs.viewer.title': 'Log personalizado',
  'customLogs.viewer.panelTitle': 'Log personalizado: {0}',
  'customLogs.field.message': 'Mensagem',
  'customLogs.field.payload': 'Payload',
  'customLogs.payload.empty': 'Este registro não tem payload.',
  'customLogs.payload.hidden': 'Você não tem permissão para ler este payload.',
  'customLogs.payload.unmapped': 'Esta fonte não mapeia um payload.',
  'customLogs.status.text': '$(broadcast) Logs Personalizados: {0} · {1}',
  'customLogs.status.action': 'Clique para mostrar o painel ou parar a captura.',
  'customLogs.status.many': '$(broadcast) Logs Personalizados: {0} capturas',
  'customLogs.status.many.action': 'Clique para mostrar o painel ou parar todas as capturas desta janela.',
  'customLogs.status.connecting': 'Conectando',
  'customLogs.status.connecting.detail': 'Conectando a {0} para capturar seus eventos.',
  'customLogs.status.standby': 'Em espera',
  'customLogs.status.standby.detail':
    'Outra janela do VS Code ou comando sf está capturando {0}; os novos eventos aparecem aqui.',
  'customLogs.status.catchingUp': 'Recuperando',
  'customLogs.status.catchingUp.detail': 'Carregando eventos de {0} publicados antes.',
  'customLogs.status.live': 'Ao vivo',
  'customLogs.status.live.detail':
    'Capturando {0}. Cada novo evento conta na cota diária de entregas de eventos da org.',
  'customLogs.status.reconnecting': 'Reconectando',
  'customLogs.status.reconnecting.detail': 'Reconectando a {0} (tentativa {1}).',
  'customLogs.status.reveal': 'Mostrar Logs Personalizados',
  'logsStatus.tooltip': 'Abra o painel Apex Logs para navegar, buscar e depurar logs do Apex.',
  'logsStatus.tooltip.org': 'Abra o painel Apex Logs para navegar, buscar e depurar os logs do Apex de {0}.',
  'customLogs.status.stop': 'Parar captura',
  'customLogs.configure.noWorkspace': 'Abra um projeto Salesforce para configurar os Logs Personalizados.',
  'customLogs.configure.noProjectFile':
    'Os Logs Personalizados leem suas fontes de plugins.electivus.customLogs no sfdx-project.json, que este workspace não tem.',
  'openLogInViewer.noDocument': 'Electivus Apex Logs: nenhum log Apex está ativo.',
  'openLogInViewer.unsupportedScheme': 'Electivus Apex Logs: não é possível abrir logs Apex deste local.',
  'openLogInViewer.notApex':
    'Electivus Apex Logs: o documento ativo não foi reconhecido como um log Apex do Salesforce.',
  'openLogInViewer.failed': 'Falha ao abrir o log Apex: {0}',
  'openLogInViewer.codeLensTitle': 'Abrir no Apex Log Viewer',
  'diagnostics.copied': 'Electivus Apex Logs: pacote de diagnóstico copiado para a área de transferência.',
  'diagnostics.copyFailed': 'Electivus Apex Logs: falha ao copiar o diagnóstico: {0}',
  cliDefaultOrgMissing:
    'Nenhuma org padrão do Salesforce está configurada. Selecione uma org na extensão ou execute "sf org login web" e defina uma org padrão.',
  cliAuthRequired: 'O Salesforce CLI não está autenticado. Execute "sf org login web" para autenticar.',
  listOrgsFailed: 'Falha ao listar as orgs Salesforce.',
  sendOrgsFailed: 'Falha ao listar as orgs Salesforce: {0}',
  openingApexLog: 'Abrindo log Apex…',
  startReplayFailed: 'Falha ao iniciar o Apex Replay Debugger: {0}',
  'debugFlags.unavailable': 'O painel Debug Flags não está disponível antes da ativação da extensão.',
  'debugFlags.noOrg': 'Nenhuma org Salesforce está selecionada.',
  'debugFlags.loadOrgsFailed': 'Falha ao carregar as orgs e os níveis de depuração: {0}',
  'debugFlags.loadUsersFailed': 'Falha ao carregar os usuários: {0}',
  'debugFlags.loadStatusFailed': 'Falha ao carregar o status da debug flag do alvo selecionado: {0}',
  'debugFlags.applySummary': 'Debug flags aplicadas a {0} alvos correspondentes ({1} criadas, {2} atualizadas).',
  'debugFlags.applyCreated': 'Debug flag criada com sucesso.',
  'debugFlags.applyUpdated': 'Debug flag atualizada com sucesso.',
  'debugFlags.applyFailed': 'Falha ao aplicar a debug flag: {0}',
  'debugFlags.removeSummary': 'Removidos {0} registros de trace flag {1} em {2} alvos correspondentes.',
  'debugFlags.removeNoneSummary': 'Nenhuma trace flag {0} foi encontrada em {1} alvos correspondentes.',
  'debugFlags.removeSuccess': 'Debug flag removida com sucesso.',
  'debugFlags.removeNone': 'Nenhuma trace flag {0} ativa foi encontrada para este alvo.',
  'debugFlags.removeFailed': 'Falha ao remover a debug flag: {0}',
  'debugFlags.targetUnavailable': 'O alvo de trace flag "{0}" não está disponível nesta org.',
  'debugFlags.managerDeveloperNameRequired': 'DeveloperName é obrigatório.',
  'debugFlags.managerMasterLabelRequired': 'MasterLabel é obrigatório.',
  'debugFlags.managerCreated': 'Nível de depuração criado com sucesso.',
  'debugFlags.managerUpdated': 'Nível de depuração atualizado com sucesso.',
  'debugFlags.managerSaveFailed': 'Falha ao salvar o nível de depuração: {0}',
  'debugFlags.managerDeleted': 'Nível de depuração excluído com sucesso.',
  'debugFlags.managerDeleteFailed': 'Falha ao excluir o nível de depuração: {0}',
  'debugFlags.runtimeDebugLevelWriteFailed': 'O runtime falhou ao gravar o nível de depuração ({0}).',
  'logsCleanup.alreadyRunning': 'Uma limpeza de logs já está em andamento.',
  'logsCleanup.actionClearAll': 'Limpar logs da org…',
  'logsCleanup.hintStorageFull':
    'O armazenamento de logs da org parece cheio. Use “Limpar logs” → “Deletar todos os logs da org” para liberar espaço.',
  'logsCleanup.confirmAction': 'Deletar',
  'logsCleanup.confirmMine.title': 'Deletar seus logs Apex da org selecionada?',
  'logsCleanup.confirmAll.title': 'Deletar todos os logs Apex da org selecionada?',
  'logsCleanup.confirmMine.detail':
    'Isto deleta permanentemente os registros ApexLog cujo LogUser é o usuário autenticado na org. Não é possível desfazer.',
  'logsCleanup.confirmAll.detail':
    'Isto deleta permanentemente os registros ApexLog armazenados na org. Não é possível desfazer.',
  'logsCleanup.progressTitleMine': 'Deletando meus logs da org…',
  'logsCleanup.progressTitleAll': 'Deletando os logs da org…',
  'logsCleanup.progressListingMine': 'Listando seus logs Apex…',
  'logsCleanup.progressListingAll': 'Listando os logs Apex da org…',
  'logsCleanup.progressDeleting': 'Deletando logs ({0}/{1})…',
  'logsCleanup.emptyMine': 'Nenhum log Apex foi encontrado para o usuário autenticado.',
  'logsCleanup.emptyAll': 'Nenhum log Apex foi encontrado na org.',
  'logsCleanup.cancelledCounts': 'Limpeza de logs cancelada ({0} deletados, {1} com falha).',
  'logsCleanup.partial': '{0} log(s) deletado(s), mas {1} falharam.',
  'logsCleanup.done': '{0} log(s) Apex deletado(s).',
  'logsCleanup.failed': 'Falha ao limpar os logs: {0}',
  downloadAllLogsAlreadyRunning: 'Um download em massa de logs já está em andamento.',
  downloadAllLogsConfirmAction: 'Baixar',
  downloadAllLogsPreflightConfirm: 'Baixar todos os logs Apex da org selecionada?',
  downloadAllLogsPreflightConfirmDetail:
    'Esta ação pode fazer muitas chamadas de API e baixar uma grande quantidade de dados.',
  downloadAllLogsProgressTitle: 'Baixando todos os logs da org…',
  downloadAllLogsProgressSyncing: 'Sincronizando os logs da org selecionada…',
  downloadAllLogsProgressMessage: '{0}/{1} logs processados…',
  downloadAllLogsSummaryCancelledDuringSync:
    'Download em massa cancelado durante a sincronização dos logs da org selecionada.',
  downloadAllLogsNoLogs: 'Nenhum log Apex foi encontrado para a org selecionada.',
  downloadAllLogsSummaryCancelledAfter: 'Download em massa cancelado após processar {0} de {1} logs.',
  downloadAllLogsSummaryPartial: 'Download em massa concluído com sucesso parcial. Sucesso: {0}, falhas: {1}.',
  downloadAllLogsSummarySuccess:
    'Download em massa concluído. {0} logs estão disponíveis localmente ({1} baixados, {2} já em cache).',
  downloadAllLogsFailed: 'Falha ao baixar todos os logs da org: {0}'
};

/** Runtime messages that read the same in pt-BR (product names), so the pt-BR bundle leaves them out. */
const sameInPtBr = new Set(['Apex Debug Flags', 'Electivus Apex Logs', 'Electivus Apex Logs Tail', 'Payload']);

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

/**
 * Builds both runtime bundles. `untranslated` lists the messages with no pt-BR entry that are not
 * in `sameInPtBr`, which a pt-BR VS Code would show in English.
 */
function buildBundles(messages = collectMessages(), existingPtBrBundle = readJsonIfExists(ptBrFile)) {
  const baseBundle = Object.fromEntries(messages.map(({ defaultMessage }) => [defaultMessage, defaultMessage]));
  const ptBrBundle = {};
  const untranslated = [];

  for (const message of messages) {
    const { legacyKey, defaultMessage } = message;
    const translated = ptBrByLegacyKey[legacyKey] || existingPtBrBundle[defaultMessage];
    if (translated && translated !== defaultMessage) {
      ptBrBundle[defaultMessage] = translated;
    } else if (!sameInPtBr.has(defaultMessage)) {
      untranslated.push(message);
    }
  }

  return { baseBundle, ptBrBundle, untranslated };
}

function main() {
  const messages = collectMessages();
  const { baseBundle, ptBrBundle, untranslated } = buildBundles(messages);

  writeJson(baseFile, baseBundle);
  writeJson(ptBrFile, ptBrBundle);

  console.log(`[l10n] wrote ${messages.length} runtime message(s) to apps/vscode-extension/l10n/bundle.l10n*.json`);
  for (const { legacyKey, location } of untranslated) {
    console.warn(`[l10n] no pt-BR translation for '${legacyKey}' (${location}); add it to ptBrByLegacyKey`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { baseFile, buildBundles, collectMessages, ptBrFile, sameInPtBr };
