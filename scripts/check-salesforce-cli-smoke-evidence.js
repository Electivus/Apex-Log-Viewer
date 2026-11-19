const { execFileSync } = require('node:child_process');

const WORKFLOW_NAME = 'E2E (Playwright • Real Org)';
const REQUEST_STEP = 'Record the JWT smoke request';
const PIN_SITES = [
  '.devcontainer/Dockerfile',
  '.github/workflows/e2e-playwright.yml',
  '.github/workflows/salesforce-cli-cache.yml',
  '.github/workflows/slot-recovery.yml',
  'docker-compose.e2e-proxy.yml',
  'scripts/run-tests.js',
  'scripts/setup-salesforce-cli.mjs',
  'test/e2e/proxy-lab/Dockerfile.runner'
];
const PIN = /@salesforce\/cli@(\d+\.\d+\.\d+)/g;

function pinnedReleases(sources) {
  const releases = sources.flatMap(source => Array.from(String(source ?? '').matchAll(PIN), match => match[1]));
  return [...new Set(releases)].sort().join(',');
}

function changesCliPin(baseSources, headSources) {
  return pinnedReleases(baseSources) !== pinnedReleases(headSources);
}

function findRunIds(body, repo) {
  const link = new RegExp(`github\\.com/${repo}/actions/runs/(\\d+)`, 'gi');
  return [...new Set(Array.from(String(body ?? '').matchAll(link), match => match[1]))];
}

function runProblem(run, headSha) {
  if (run.workflowName !== WORKFLOW_NAME) return `is a run of ${run.workflowName}, not ${WORKFLOW_NAME}`;
  if (run.event !== 'workflow_dispatch') return `came from ${run.event}, not a manual dispatch`;
  if (run.headSha !== headSha) return `ran ${run.headSha.slice(0, 7)}, not the head ${headSha.slice(0, 7)}`;
  if (run.conclusion !== 'success') return `ended ${run.conclusion ?? run.status}`;
  const requested = run.jobs.some(job =>
    job.steps.some(step => step.name === REQUEST_STEP && step.conclusion === 'success')
  );
  return requested ? null : 'was dispatched without jwt_smoke_devhub_org_id';
}

function decideEvidence({ pinChanged, runIds, runs, headSha }) {
  if (!pinChanged) return { ok: true, message: 'The Salesforce CLI pin is unchanged.' };
  if (runIds.length === 0) {
    return { ok: false, message: 'The pin changed. Link a JWT smoke run on this head in the PR description.' };
  }
  const results = runs.map(run => ({ id: run.databaseId, problem: runProblem(run, headSha) }));
  if (results.some(({ problem }) => problem === null)) {
    return { ok: true, message: 'A linked JWT smoke run passed on the PR head.' };
  }
  const reasons = results.map(({ id, problem }) => `Run ${id} ${problem}.`).join(' ');
  return { ok: false, message: `The pin changed and no linked run is a passing JWT smoke on the head. ${reasons}` };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(env) {
  const { REPO, PR_NUMBER, BASE_SHA, HEAD_SHA } = env;
  const show = rev =>
    PIN_SITES.map(site => {
      try {
        return execFileSync('git', ['show', `${rev}:${site}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch {
        return '';
      }
    });
  const pinChanged = changesCliPin(show(BASE_SHA), show('HEAD'));
  // The event payload is stale on a re-run, so read the description live.
  const body = JSON.parse(gh(['pr', 'view', PR_NUMBER, '--repo', REPO, '--json', 'body'])).body;
  const runIds = pinChanged ? findRunIds(body, REPO) : [];
  const runs = runIds.map(id =>
    JSON.parse(
      gh(['run', 'view', id, '--repo', REPO, '--json', 'databaseId,workflowName,event,headSha,conclusion,status,jobs'])
    )
  );
  const verdict = decideEvidence({ pinChanged, runIds, runs, headSha: HEAD_SHA });
  console.log(verdict.ok ? verdict.message : `::error::${verdict.message}`);
  return verdict.ok ? 0 : 1;
}

module.exports = {
  pinnedReleases,
  PIN_SITES,
  changesCliPin,
  findRunIds,
  runProblem,
  decideEvidence,
  REQUEST_STEP,
  WORKFLOW_NAME
};

if (require.main === module) process.exit(main(process.env));
