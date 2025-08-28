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
  tailSelectDebugLevel: 'Select a debug level',
  tailHardStop: 'Tail stopped after 30 minutes.',
  tailSavedTo: 'Saved to {0}',
  selectOrgPlaceholder: 'Select an authenticated org',
  selectOrgDefault: 'Default',
  'salesforce.logs.view.name': 'Apex Logs',
  'salesforce.tail.view.name': 'Apex Log Tail'
};

// Brazilian Portuguese (fallback translations)
const ptBr = {
  openError: 'Falha ao abrir o log: ',
  replayError: 'Falha ao iniciar o Apex Replay Debugger: ',
  replayStarting: 'Iniciando o Apex Replay Debugger…',
  tailSelectDebugLevel: 'Selecione um nível de depuração',
  tailHardStop: 'Tail parado após 30 minutos.',
  tailSavedTo: 'Salvo em {0}',
  selectOrgPlaceholder: 'Selecione uma org autenticada',
  selectOrgDefault: 'Padrão',
  'salesforce.logs.view.name': 'Logs Apex',
  'salesforce.tail.view.name': 'Tail de Log Apex'
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
