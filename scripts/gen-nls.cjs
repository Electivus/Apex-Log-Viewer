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
  replayError: 'Failed to launch Apex Replay Debugger: '
};

// Brazilian Portuguese (fallback translations)
const ptBr = {
  openError: 'Falha ao abrir o log: ',
  replayError: 'Falha ao iniciar o Apex Replay Debugger: '
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
