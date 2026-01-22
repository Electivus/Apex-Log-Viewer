#!/usr/bin/env node
// Blocks committing forbidden file types staged via lint-staged
// Usage: lint-staged passes matched files as argv

const path = require('path');

const args = process.argv.slice(2);

// Optional label for nicer error messages (e.g., --label='.log')
let label = '.forbidden';
const labelArg = args.find((a) => a.startsWith('--label='));
const files = args.filter((a) => !a.startsWith('--label='));
if (labelArg) label = labelArg.split('=')[1] || label;

if (files.length === 0) {
  process.exit(0);
}

const rel = (f) => path.relative(process.cwd(), f || '');

const list = files.map(rel).join('\n  - ');
const msg = `\n❌ Bloqueado: arquivos ${label} não são permitidos no commit.\n\nArquivos detectados:\n  - ${list}\n\nDica:\n- Mantenha logs apenas localmente (ex.: diretório 'apexlogs/' já está no .gitignore).\n- Se adicionou por engano, use: git restore --staged <arquivo>\n- Se precisar revisar, compartilhe por meio seguro e não versione.\n`;

console.error(msg);
process.exit(1);

