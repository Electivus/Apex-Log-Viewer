/* Minimal fallback NLS file generator for bundled build.
 * Generates dist/extension.nls.json and dist/extension.nls.pt-br.json
 * based on known message keys used in the extension runtime.
 */
const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJSON(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const distDir = path.join(__dirname, '..', 'dist');
const baseFile = path.join(distDir, 'extension.nls.json');
const ptBrFile = path.join(distDir, 'extension.nls.pt-br.json');

// Default English messages (keys used in the extension bundle)
const en = {
  openError: 'Failed to open log: ',
  replayError: 'Failed to launch Apex Replay Debugger: ',
  replayStarting: 'Starting Apex Replay Debugger…',
  replayMissingExtMessage: 'Salesforce Extension Pack (includes Apex Replay Debugger) is required to replay logs.',
  replayMissingExtInstall: 'Install',
  replayMissingExtOpen: 'Open Extensions',
  replayPackAdvice: 'Tip: To use Apex Replay, install the Salesforce Extension Pack (salesforce.salesforcedx-vscode).',
  tailSelectDebugLevel: 'Select a debug level',
  tailHardStop: 'Tail stopped after 30 minutes.',
  tailSavedTo: 'Saved to {0}',
  tailSaveFailed: 'Tail: failed to save log to workspace (best-effort).',
  cliNotFound: 'Salesforce CLI not found. Install Salesforce CLI (sf) or SFDX CLI (sfdx).',
  cliTimeout: 'Salesforce CLI command timed out after {0} seconds.',
  cliAuthFailed:
    'Could not obtain credentials via sf/sfdx CLI. Verify authentication and try: sf org display --json --verbose',
  selectOrgPlaceholder: 'Select an authenticated org',
  selectOrgDefault: 'Default',
  selectOrgError: 'Electivus Apex Logs: Failed to list orgs',
  noOrgSelected: 'Electivus Apex Logs: No Salesforce org selected',
  resetCliCacheError: 'Electivus Apex Logs: Failed to clear CLI cache',
  refreshingLogs: 'Refreshing logs…',
  listingOrgs: 'Listing Salesforce orgs…',
  'salesforce.logs.view.name': 'Electivus Apex Logs',
  'salesforce.tail.view.name': 'Electivus Apex Logs Tail'
};

// Brazilian Portuguese (fallback translations)
const ptBr = {
  openError: 'Falha ao abrir o log: ',
  replayError: 'Falha ao iniciar o Apex Replay Debugger: ',
  replayStarting: 'Iniciando o Apex Replay Debugger…',
  replayMissingExtMessage: 'Para reproduzir logs é necessário o Salesforce Extension Pack (inclui o Apex Replay Debugger).',
  replayMissingExtInstall: 'Instalar',
  replayMissingExtOpen: 'Abrir Extensões',
  replayPackAdvice: 'Dica: Para usar o Apex Replay, instale o Salesforce Extension Pack (salesforce.salesforcedx-vscode).',
  tailSelectDebugLevel: 'Selecione um nível de depuração',
  tailHardStop: 'Tail parado após 30 minutos.',
  tailSavedTo: 'Salvo em {0}',
  tailSaveFailed: 'Tail: falha ao salvar log no workspace (melhor esforço).',
  cliNotFound: 'Salesforce CLI não encontrada. Instale o Salesforce CLI (sf) ou SFDX CLI (sfdx).',
  cliTimeout: 'Comando do Salesforce CLI expirou após {0} segundos.',
  cliAuthFailed:
    'Não foi possível obter credenciais via sf/sfdx CLI. Verifique a autenticação e tente: sf org display --json --verbose',
  selectOrgPlaceholder: 'Selecione uma org autenticada',
  selectOrgDefault: 'Padrão',
  selectOrgError: 'Electivus Apex Logs: falha ao listar orgs',
  noOrgSelected: 'Electivus Apex Logs: Nenhuma org do Salesforce selecionada',
  resetCliCacheError: 'Electivus Apex Logs: falha ao limpar cache do CLI',
  refreshingLogs: 'Atualizando logs…',
  listingOrgs: 'Listando orgs Salesforce…',
  'salesforce.logs.view.name': 'Electivus Apex Logs',
  'salesforce.tail.view.name': 'Electivus Apex Logs Tail'
};

if (!fs.existsSync(baseFile)) {
  writeJSON(baseFile, en);
} else {
  // Optionally merge in new keys
  try {
    const current = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
    writeJSON(baseFile, { ...en, ...current });
  } catch {
    writeJSON(baseFile, en);
  }
}

if (!fs.existsSync(ptBrFile)) {
  writeJSON(ptBrFile, ptBr);
} else {
  try {
    const current = JSON.parse(fs.readFileSync(ptBrFile, 'utf8'));
    writeJSON(ptBrFile, { ...ptBr, ...current });
  } catch {
    writeJSON(ptBrFile, ptBr);
  }
}

console.log('[nls] ensured dist/extension.nls*.json');
