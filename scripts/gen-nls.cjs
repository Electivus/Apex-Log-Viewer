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
  replayCommandsUnavailableMessage:
    'Apex Replay Debugger is installed (salesforce.salesforcedx-vscode-apex-replay-debugger), but its commands are unavailable. Ensure it is enabled in this VS Code environment (Local/WSL/SSH/Dev Containers), then reload the window and try again.',
  replayMissingExtMessage:
    'Apex Replay Debugger is unavailable. Install the Salesforce Extension Pack (salesforce.salesforcedx-vscode) or the standalone Apex Replay Debugger extension (salesforce.salesforcedx-vscode-apex-replay-debugger) and ensure it is enabled in this VS Code environment (Local/WSL/SSH/Dev Containers).',
  tailSelectDebugLevel: 'Select a debug level',
  tailHardStop: 'Tail stopped after 30 minutes.',
  tailSavedTo: 'Saved to {0}',
  tailSaveFailed: 'Tail: failed to save log to workspace (best-effort).',
  cliNotFound: 'Salesforce CLI not found. Install Salesforce CLI (sf).',
  cliTimeout: 'Salesforce CLI command timed out after {0} seconds.',
  cliAuthFailed:
    'Could not obtain credentials via Salesforce CLI. Verify authentication and try: sf org display --json --verbose',
  selectOrgPlaceholder: 'Select an authenticated org',
  selectOrgDefault: 'Default',
  selectOrgError: 'Electivus Apex Logs: Failed to list orgs',
  'webviewTroubleshooting.message':
    'If an Apex Logs view fails with "Could not register service worker", close all {0} windows, delete the webview cache at {1}, and reopen the IDE. This is a VS Code webview-host issue, not the extension CLI cache.',
  'webviewTroubleshooting.remoteMessage':
    'If an Apex Logs view fails with "Could not register service worker" while connected to {1}, close all {0} windows on your local machine and clear the webview cache from the local VS Code UI host.\n\nWindows: {2}\nmacOS: {3}\nLinux: {4}\n\nThis cache is local to the VS Code UI machine, not the remote extension host or the extension CLI cache.',
  'webviewTroubleshooting.openFolder': 'Open Cache Folder',
  'webviewTroubleshooting.copyPath': 'Copy Cache Path',
  'webviewTroubleshooting.copySteps': 'Copy Recovery Steps',
  'webviewTroubleshooting.showOutput': 'Show Extension Output',
  'webviewTroubleshooting.copied': 'Copied webview cache path: {0}',
  'webviewTroubleshooting.remoteCopied': 'Copied webview recovery steps.',
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
  replayCommandsUnavailableMessage:
    'Apex Replay Debugger está instalado (salesforce.salesforcedx-vscode-apex-replay-debugger), mas seus comandos não estão disponíveis. Garanta que esteja habilitado neste ambiente do VS Code (Local/WSL/SSH/Dev Containers), recarregue a janela e tente novamente.',
  replayMissingExtMessage:
    'Apex Replay Debugger não está disponível. Instale o Salesforce Extension Pack (salesforce.salesforcedx-vscode) ou a extensão avulsa Apex Replay Debugger (salesforce.salesforcedx-vscode-apex-replay-debugger) e garanta que esteja habilitado neste ambiente do VS Code (Local/WSL/SSH/Dev Containers).',
  tailSelectDebugLevel: 'Selecione um nível de depuração',
  tailHardStop: 'Tail parado após 30 minutos.',
  tailSavedTo: 'Salvo em {0}',
  tailSaveFailed: 'Tail: falha ao salvar log no workspace (melhor esforço).',
  cliNotFound: 'Salesforce CLI não encontrada. Instale o Salesforce CLI (sf).',
  cliTimeout: 'Comando do Salesforce CLI expirou após {0} segundos.',
  cliAuthFailed:
    'Não foi possível obter credenciais via Salesforce CLI. Verifique a autenticação e tente: sf org display --json --verbose',
  selectOrgPlaceholder: 'Selecione uma org autenticada',
  selectOrgDefault: 'Padrão',
  selectOrgError: 'Electivus Apex Logs: falha ao listar orgs',
  'webviewTroubleshooting.message':
    'Se uma view do Apex Logs falhar com "Could not register service worker", feche todas as janelas do {0}, exclua o cache de webview em {1} e reabra a IDE. Este é um problema do host de webview do VS Code, não do cache de CLI da extensão.',
  'webviewTroubleshooting.remoteMessage':
    'Se uma view do Apex Logs falhar com "Could not register service worker" enquanto você estiver conectado via {1}, feche todas as janelas do {0} na sua máquina local e limpe o cache de webview do host local da UI do VS Code.\n\nWindows: {2}\nmacOS: {3}\nLinux: {4}\n\nEsse cache fica na máquina local da UI do VS Code, não no extension host remoto nem no cache de CLI da extensão.',
  'webviewTroubleshooting.openFolder': 'Abrir Pasta do Cache',
  'webviewTroubleshooting.copyPath': 'Copiar Caminho do Cache',
  'webviewTroubleshooting.copySteps': 'Copiar Passos de Recuperação',
  'webviewTroubleshooting.showOutput': 'Mostrar Saída da Extensão',
  'webviewTroubleshooting.copied': 'Caminho do cache de webview copiado: {0}',
  'webviewTroubleshooting.remoteCopied': 'Passos de recuperação do webview copiados.',
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
