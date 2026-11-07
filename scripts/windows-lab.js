#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const REPO_ROOT = path.join(__dirname, '..');
const TEMPLATE_FILE = path.join(REPO_ROOT, 'infra', 'windows-lab', 'main.bicep');
const BOOTSTRAP_FILE = path.join(__dirname, 'windows-lab-bootstrap.ps1');
const REPO_URL = 'https://github.com/Electivus/Apex-Log-Viewer.git';

const LAB_GROUP_PATTERN = /^rg-alv-windows-lab-[a-z0-9]+$/;
const LAB_TAG = 'alv-lab=windows';
const VM_NAME = 'alv-win-lab';
const ADMIN_USER = 'alvadmin';
const IP_NAME = `${VM_NAME}-ip`;
const NIC_NAME = `${VM_NAME}-nic`;
const SCHEDULE_NAME = `shutdown-computevm-${VM_NAME}`;
const KEYCHAIN_SERVICE = 'alv-windows-lab';
const HOST_KEY_ALIAS = 'alv-windows-lab';

// standardDSv5Family has no quota on the current subscription, and Dsv4 has the same retail price.
const DEFAULT_SIZE = 'Standard_D4s_v4';
const DEFAULT_LOCATION = 'eastus';
const DEFAULT_GUARD_HOURS = 4;
// The schedule lands after the deployment. A time that has passed by then fires only on the next day.
const MIN_GUARD_HOURS = 0.25;
const MAX_GUARD_HOURS = 23;
const BOOTSTRAP_TIMEOUT_MS = 45 * 60 * 1000;

const HELP = `Usage:
  node scripts/windows-lab.js up [--ref <git-ref>] [--hours <n>] [--size <vm-size>]
  node scripts/windows-lab.js ssh [--tty] [-- <command>]
  node scripts/windows-lab.js rdp
  node scripts/windows-lab.js status
  node scripts/windows-lab.js down
  node scripts/windows-lab.js destroy

Options for every command:
  --location <region>        Azure region. Default ${DEFAULT_LOCATION}.
  --resource-group <name>    Lab group. Default rg-alv-windows-lab-<region>. Must match ${LAB_GROUP_PATTERN}.

up converges the lab and sets the Azure auto-shutdown to --hours from now (default ${DEFAULT_GUARD_HOURS}).
down deallocates the VM and deletes the public IP. destroy deletes the whole group.
See docs/WINDOWS_LAB.md.
`;

function assertLabGroup(name) {
  if (!LAB_GROUP_PATTERN.test(String(name))) {
    throw new Error(`Refusing resource group "${name}". The lab manages only groups that match ${LAB_GROUP_PATTERN}.`);
  }
  return name;
}

function parseRequest(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      location: { type: 'string', default: DEFAULT_LOCATION },
      'resource-group': { type: 'string' },
      ref: { type: 'string', default: '' },
      hours: { type: 'string', default: String(DEFAULT_GUARD_HOURS) },
      size: { type: 'string' },
      tty: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  });
  const [command = '', ...rest] = positionals;
  if (values.help || !command) return { command: 'help' };
  if (!['up', 'ssh', 'rdp', 'status', 'down', 'destroy'].includes(command)) {
    throw new Error(`Unknown command "${command}". Run with --help.`);
  }
  if (!/^[a-z0-9]+$/.test(values.location)) throw new Error('--location must be an Azure region name.');
  if (values.ref && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(values.ref)) {
    throw new Error('--ref must be a branch, a tag, a commit or a refs/ path.');
  }
  if (values.size && !/^Standard_[A-Za-z0-9_]+$/.test(values.size)) throw new Error('--size must be an Azure VM size.');
  const hours = Number(values.hours);
  if (!(hours >= MIN_GUARD_HOURS && hours <= MAX_GUARD_HOURS)) {
    throw new Error(`--hours must be between ${MIN_GUARD_HOURS} and ${MAX_GUARD_HOURS}.`);
  }
  return {
    command,
    group: assertLabGroup(values['resource-group'] ?? `rg-alv-windows-lab-${values.location}`),
    location: values.location,
    ref: values.ref,
    hours,
    size: values.size,
    tty: values.tty,
    remote: rest
  };
}

function shutdownTimeUtc(now, hours) {
  const at = new Date(Math.ceil((now.getTime() + hours * 3600 * 1000) / 60000) * 60000);
  return `${String(at.getUTCHours()).padStart(2, '0')}${String(at.getUTCMinutes()).padStart(2, '0')}`;
}

function minutesUntil(now, hhmm) {
  const target = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (target - current + 24 * 60) % (24 * 60);
}

function redact(text) {
  return String(text)
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, '<id>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
}

function planUp(state, request) {
  if (!state) return { size: request.size ?? DEFAULT_SIZE, recreate: false, start: false };
  const size = request.size ?? state.size;
  if (state.provisioning === 'Failed') return { size, recreate: true, start: false };
  return { size, recreate: false, start: state.power !== 'VM running' };
}

function parseBootstrapOutput(message) {
  const lines = String(message)
    .split(/\r?\n/)
    .map(line => line.trim());
  const values = {};
  for (const line of lines) {
    const match = /^ALV_([A-Z_]+)=(.*)$/.exec(line);
    if (match) (values[match[1]] ??= []).push(match[2]);
  }
  const hostKey = values.HOST_KEY?.[0];
  if (!lines.includes('ALV_BOOTSTRAP_OK') || !/^ssh-ed25519 \S+/.test(hostKey ?? '')) {
    throw new Error(`The bootstrap did not finish.\n${redact(message)}`);
  }
  return {
    hostKey: hostKey.split(/\s+/).slice(0, 2).join(' '),
    steps: values.STEP ?? [],
    versions: {
      git: values.GIT?.[0],
      node: values.NODE?.[0],
      pnpm: values.PNPM?.[0],
      ref: values.REF?.[0],
      defenderRealtime: values.DEFENDER_REALTIME?.[0]
    }
  };
}

function generatePassword() {
  return `Aa1-${randomBytes(24).toString('base64url')}`;
}

function buildSshArgs({ keyFile, knownHostsFile, address, tty, remote }) {
  return [
    '-i',
    keyFile,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsFile}`,
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `HostKeyAlias=${HOST_KEY_ALIAS}`,
    '-o',
    'ConnectTimeout=20',
    '-o',
    'ServerAliveInterval=30',
    ...(tty ? ['-t'] : []),
    `${ADMIN_USER}@${address}`,
    ...(remote.length > 0 ? [remote.join(' ')] : [])
  ];
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command} failed: ${redact(result.error.message)}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function realDeps() {
  const home = process.env.ALV_WINDOWS_LAB_HOME || path.join(os.homedir(), '.config', 'alv-windows-lab');
  return {
    home,
    now: () => new Date(),
    log: message => console.log(`[windows-lab] ${message}`),
    az: (args, options = {}) => {
      const result = runCaptured('az', args, {
        env: { ...process.env, AZURE_CORE_ONLY_SHOW_ERRORS: '1' },
        timeout: options.timeout
      });
      if (result.status !== 0 && !options.allowFailure) {
        throw new Error(`az ${args.slice(0, 3).join(' ')} failed: ${redact(result.stderr)}`);
      }
      return result;
    },
    operatorIp: () => {
      const { stdout } = runCaptured('curl', ['-4', '-fsS', '--max-time', '15', 'https://checkip.amazonaws.com']);
      const ip = stdout.trim();
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))
        throw new Error('Could not read the public IPv4 address of this machine.');
      return ip;
    },
    keychainRead: () => {
      const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', ADMIN_USER, '-w'];
      const result = runCaptured('security', args);
      return result.status === 0 ? result.stdout.trim() : '';
    },
    keychainWrite: password => {
      // Through stdin, because an argument would show in the process list.
      const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${ADMIN_USER} -w "${password}"\n`;
      const result = runCaptured('security', ['-i'], { input: command });
      if (result.status !== 0) throw new Error('Could not store the password in the macOS Keychain.');
    },
    keychainDelete: () => {
      runCaptured('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', ADMIN_USER]);
    },
    ensureSshKey: keyFile => {
      if (fs.existsSync(keyFile)) return;
      const result = runCaptured('ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        'alv-windows-lab',
        '-f',
        keyFile
      ]);
      if (result.status !== 0) throw new Error('ssh-keygen failed.');
    },
    runSsh: args =>
      new Promise(resolve => {
        const child = spawn('ssh', args, { stdio: ['inherit', 'inherit', 'pipe'] });
        child.stderr.on('data', chunk => process.stderr.write(redact(chunk)));
        child.on('close', code => resolve(code ?? 255));
      }),
    openFile: file => runCaptured('open', [file]).status === 0
  };
}

class Lab {
  constructor(request, deps) {
    this.request = request;
    this.deps = deps;
    this.group = request.group;
    this.keyFile = path.join(deps.home, 'id_ed25519');
    this.knownHostsFile = path.join(deps.home, 'known_hosts');
  }

  az(args, options) {
    return this.deps.az(args, options);
  }

  groupExists() {
    return this.az(['group', 'exists', '-n', this.group]).stdout.trim() === 'true';
  }

  readVm() {
    const result = this.az(
      [
        'vm',
        'show',
        '-d',
        '-g',
        this.group,
        '-n',
        VM_NAME,
        '--query',
        '{power:powerState,provisioning:provisioningState,size:hardwareProfile.vmSize}',
        '-o',
        'json'
      ],
      { allowFailure: true }
    );
    if (result.status === 0) return JSON.parse(result.stdout);
    if (/NotFound/.test(result.stderr)) return null;
    throw new Error(`az vm show failed: ${redact(result.stderr)}`);
  }

  readGuard() {
    const result = this.az(
      [
        'resource',
        'show',
        '-g',
        this.group,
        '-n',
        SCHEDULE_NAME,
        '--resource-type',
        'Microsoft.DevTestLab/schedules',
        '--query',
        '{status:properties.status,time:properties.dailyRecurrence.time}',
        '-o',
        'json'
      ],
      { allowFailure: true }
    );
    return result.status === 0 ? JSON.parse(result.stdout) : null;
  }

  readAddress() {
    const result = this.az(
      ['network', 'public-ip', 'show', '-g', this.group, '-n', IP_NAME, '--query', 'ipAddress', '-o', 'tsv'],
      { allowFailure: true }
    );
    return result.status === 0 ? result.stdout.trim() : '';
  }

  ensureLocalState() {
    fs.mkdirSync(this.deps.home, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.deps.home, 0o700);
    this.deps.ensureSshKey(this.keyFile);
  }

  ensurePassword(vmExists) {
    const stored = this.deps.keychainRead();
    if (stored) return stored;
    if (vmExists) {
      throw new Error('The VM exists but its password is not in the Keychain. Run destroy, then up.');
    }
    const password = generatePassword();
    this.deps.keychainWrite(password);
    return password;
  }

  deploy(size, password, operatorIp, time) {
    const parametersFile = path.join(this.deps.home, 'deployment-parameters.json');
    const parameters = {
      location: this.request.location,
      vmName: VM_NAME,
      adminUsername: ADMIN_USER,
      adminPassword: password,
      operatorIp,
      vmSize: size,
      shutdownTimeUtc: time
    };
    const body = Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, { value }]));
    fs.writeFileSync(parametersFile, JSON.stringify({ parameters: body }), { mode: 0o600 });
    try {
      this.az([
        'deployment',
        'group',
        'create',
        '-g',
        this.group,
        '-n',
        'alv-windows-lab',
        '--template-file',
        TEMPLATE_FILE,
        '--parameters',
        `@${parametersFile}`,
        '-o',
        'none'
      ]);
    } finally {
      fs.rmSync(parametersFile, { force: true });
    }
  }

  deleteVm() {
    this.az(['vm', 'delete', '-g', this.group, '-n', VM_NAME, '--yes', '-o', 'none'], { allowFailure: true });
  }

  convergeInfrastructure(state, password, operatorIp, time) {
    const plan = planUp(state, this.request);
    if (plan.recreate) {
      this.deps.log('Replacing a VM that failed to provision. Its disk goes with it.');
      this.deleteVm();
    }
    this.deploy(plan.size, password, operatorIp, time);
    if (plan.start) this.az(['vm', 'start', '-g', this.group, '-n', VM_NAME, '-o', 'none']);
  }

  bootstrap() {
    const publicKey = fs.readFileSync(`${this.keyFile}.pub`, 'utf8').trim();
    const parameters = [
      `PublicKeyBase64=${Buffer.from(publicKey).toString('base64')}`,
      `AdminUser=${ADMIN_USER}`,
      `RepoUrl=${REPO_URL}`,
      ...(this.request.ref ? [`Ref=${this.request.ref}`] : [])
    ];
    const { stdout } = this.az(
      [
        'vm',
        'run-command',
        'invoke',
        '-g',
        this.group,
        '-n',
        VM_NAME,
        '--command-id',
        'RunPowerShellScript',
        '--scripts',
        `@${BOOTSTRAP_FILE}`,
        '--parameters',
        ...parameters,
        '-o',
        'json'
      ],
      { timeout: BOOTSTRAP_TIMEOUT_MS }
    );
    const message = (JSON.parse(stdout).value ?? []).map(entry => entry.message).join('\n');
    return parseBootstrapOutput(message);
  }

  async up() {
    const { log, now } = this.deps;
    const started = now().getTime();
    const phase = name => log(`${name} at ${Math.round((now().getTime() - started) / 1000)}s`);

    this.ensureLocalState();
    const operatorIp = this.deps.operatorIp();
    this.az(['group', 'create', '-n', this.group, '-l', this.request.location, '--tags', LAB_TAG, '-o', 'none']);
    const state = this.readVm();
    const password = this.ensurePassword(Boolean(state));
    const time = shutdownTimeUtc(now(), this.request.hours);

    phase('Deploying');
    this.convergeInfrastructure(state, password, operatorIp, time);
    const guard = this.readGuard();
    if (guard?.status !== 'Enabled' || guard.time !== time) {
      throw new Error('The Azure auto-shutdown did not land. Run down now, then up again.');
    }

    phase('Bootstrapping');
    const { hostKey, steps, versions } = this.bootstrap();
    fs.writeFileSync(this.knownHostsFile, `${HOST_KEY_ALIAS} ${hostKey}\n`, { mode: 0o600 });

    const code = await this.ssh(['echo', 'ssh-ok'], false);
    if (code !== 0) throw new Error(`SSH to the VM failed with exit code ${code}.`);

    log(`Bootstrap steps: ${steps.join(', ')}`);
    log(
      `Ready: git ${versions.git}, node ${versions.node}, pnpm ${versions.pnpm}, commit ${versions.ref}, Defender realtime ${versions.defenderRealtime}.`
    );
    log(`The VM deallocates at ${time} UTC, in ${minutesUntil(now(), time)} minutes.`);
    phase('Up');
  }

  async ssh(remote, tty) {
    const address = this.readAddress();
    if (!address) throw new Error('The lab has no public IP. Run up.');
    const args = buildSshArgs({
      keyFile: this.keyFile,
      knownHostsFile: this.knownHostsFile,
      address,
      tty,
      remote
    });
    return this.deps.runSsh(args);
  }

  rdp() {
    const address = this.readAddress();
    if (!address) throw new Error('The lab has no public IP. Run up.');
    const file = path.join(this.deps.home, 'alv-windows-lab.rdp');
    fs.writeFileSync(file, `full address:s:${address}\nusername:s:${ADMIN_USER}\nprompt for credentials:i:1\n`, {
      mode: 0o600
    });
    this.deps.log(`User: ${ADMIN_USER}.`);
    this.deps.log(
      `Copy the password with: security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${ADMIN_USER} -w | pbcopy`
    );
    if (!this.deps.openFile(file)) {
      this.deps.log(`No app opened the connection file. Install Windows App, then open ${file}.`);
    }
  }

  status() {
    const { log, now } = this.deps;
    if (!this.groupExists()) {
      log(`Group ${this.group} does not exist. Nothing bills.`);
      return;
    }
    const vm = this.readVm();
    log(vm ? `VM: ${vm.power}, ${vm.size}.` : 'VM: absent.');
    const guard = this.readGuard();
    if (guard) {
      log(`Auto-shutdown: ${guard.status} at ${guard.time} UTC, in ${minutesUntil(now(), guard.time)} minutes.`);
    } else if (vm?.power === 'VM running') {
      log('WARNING: the VM is running without an auto-shutdown. Run up or down.');
    }
    const { stdout } = this.az(['resource', 'list', '-g', this.group, '--query', '[].[type,name]', '-o', 'tsv']);
    log('Resources:');
    for (const line of stdout.trim().split('\n').filter(Boolean)) log(`  ${line.replace('\t', ' ')}`);
  }

  down() {
    const { log } = this.deps;
    if (!this.groupExists()) {
      log(`Group ${this.group} does not exist. Nothing to do.`);
      return;
    }
    if (this.readVm()) this.az(['vm', 'deallocate', '-g', this.group, '-n', VM_NAME, '-o', 'none']);
    if (this.readAddress()) {
      this.az([
        'network',
        'nic',
        'ip-config',
        'update',
        '-g',
        this.group,
        '--nic-name',
        NIC_NAME,
        '-n',
        'primary',
        '--remove',
        'publicIpAddress',
        '-o',
        'none'
      ]);
      this.az(['network', 'public-ip', 'delete', '-g', this.group, '-n', IP_NAME, '-o', 'none']);
    }
    log('Deallocated, and the public IP is deleted. The OS disk still bills. Use destroy to stop that.');
  }

  destroy() {
    const { log } = this.deps;
    if (!this.groupExists()) {
      log(`Group ${this.group} does not exist. Nothing to do.`);
      this.deps.keychainDelete();
      return;
    }
    const { stdout } = this.az(['group', 'show', '-n', this.group, '--query', 'tags."alv-lab"', '-o', 'tsv']);
    if (stdout.trim() !== 'windows') {
      throw new Error(`Refusing to delete ${this.group} because it lacks the tag ${LAB_TAG}.`);
    }
    this.az(['group', 'delete', '-n', this.group, '--yes', '-o', 'none']);
    this.deps.keychainDelete();
    log(`Deleted ${this.group}. Nothing bills.`);
  }
}

async function runCli(argv, deps) {
  const request = parseRequest(argv);
  if (request.command === 'help') {
    console.log(HELP);
    return 0;
  }
  const lab = new Lab(request, deps);
  switch (request.command) {
    case 'up':
      await lab.up();
      return 0;
    case 'ssh':
      return lab.ssh(request.remote, request.tty);
    case 'rdp':
      lab.rdp();
      return 0;
    case 'status':
      lab.status();
      return 0;
    case 'down':
      lab.down();
      return 0;
    case 'destroy':
      lab.destroy();
      return 0;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2), realDeps()).then(
    code => {
      process.exitCode = code;
    },
    error => {
      console.error(`[windows-lab] ${redact(error.message)}`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  assertLabGroup,
  buildSshArgs,
  generatePassword,
  minutesUntil,
  parseBootstrapOutput,
  parseRequest,
  planUp,
  redact,
  runCli,
  shutdownTimeUtc
};
