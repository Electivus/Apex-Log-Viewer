#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const TEMPLATE_FILE = path.join(REPO_ROOT, 'infra', 'azure-monitor', 'main.bicep');

function getArgValue(name) {
  const prefix = `--${name}=`;
  const direct = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  if (direct) {
    return direct.slice(prefix.length);
  }

  const args = process.argv.slice(2);
  const index = args.findIndex(arg => arg === `--${name}`);
  if (index >= 0 && index + 1 < args.length) {
    return args[index + 1];
  }

  return '';
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/deploy-azure-monitor.js --resource-group <name> [--parameters-file <path>] [--what-if]
  node scripts/deploy-azure-monitor.js --resource-group <name> [--parameters-file <path>] [--set key=value ...]

Options:
  --resource-group      Target Azure resource group for the deployment. Required.
  --parameters-file     Optional .bicepparam file to feed into the deployment.
  --what-if             Run az deployment group what-if instead of create.
  --set                 Additional template parameters in key=value form. Repeat as needed.
  --help                Show this help text.
`);
}

function collectSetArguments() {
  const args = process.argv.slice(2);
  const collected = [];

  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--set' && index + 1 < args.length) {
      collected.push(args[index + 1]);
      index += 1;
    }
  }

  return collected;
}

async function main() {
  if (hasFlag('help')) {
    printHelp();
    return;
  }

  const resourceGroup = getArgValue('resource-group');
  const parametersFile = getArgValue('parameters-file');
  const mode = hasFlag('what-if') ? 'what-if' : 'create';
  const parameterOverrides = collectSetArguments();

  if (!resourceGroup) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const args = ['deployment', 'group', mode, '--resource-group', resourceGroup, '--template-file', TEMPLATE_FILE];

  if (parametersFile) {
    args.push('--parameters', path.resolve(REPO_ROOT, parametersFile));
  }

  if (parameterOverrides.length > 0) {
    args.push('--parameters', ...parameterOverrides);
  }

  const child = spawn('az', args, {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  });

  child.on('exit', code => {
    process.exitCode = typeof code === 'number' ? code : 1;
  });
}

main().catch(error => {
  console.error('[deploy-azure-monitor] Failed:', error && error.message ? error.message : error);
  process.exit(1);
});
