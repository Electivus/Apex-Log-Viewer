const { execFileSync } = require('node:child_process');

const STATUS_CONTEXT = 'Codex review';
const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
const DEPENDABOT_LOGIN = 'dependabot[bot]';
const STATE_MARKER = /<!-- codex-review-state:v1 (.*?) -->/s;

function isCodexComment(comment) {
  return comment.user?.login === CODEX_LOGIN && comment.user.type === 'Bot';
}

// Codex edits its single summary comment in place, so the last marked comment is the current one.
function parseCodexReview(comments) {
  const comment = comments.findLast(candidate => isCodexComment(candidate) && STATE_MARKER.test(candidate.body));
  if (!comment) return null;
  try {
    const { commit_sha, status, has_unresolved_findings } = JSON.parse(STATE_MARKER.exec(comment.body)[1]).code_review;
    return { commitSha: commit_sha, status, hasUnresolvedFindings: has_unresolved_findings, url: comment.html_url };
  } catch {
    return null;
  }
}

// has_any_findings is cumulative over the PR, so only has_unresolved_findings speaks for the head.
function decideGate({ author, headSha, review }) {
  const head = headSha.slice(0, 7);
  if (author === DEPENDABOT_LOGIN) {
    return { state: 'success', description: 'Codex does not review Dependabot pull requests' };
  }
  if (!review) {
    return { state: 'pending', description: 'Waiting for Codex. Comment @codex review if it does not start' };
  }
  if (review.commitSha !== headSha) {
    return { state: 'pending', description: `Codex has not reviewed ${head} yet` };
  }
  if (review.status !== 'completed') {
    return { state: 'pending', description: `Codex review is ${review.status ?? 'not started'}` };
  }
  if (review.hasUnresolvedFindings !== false) {
    return { state: 'failure', description: `Codex reported findings on ${head}` };
  }
  return { state: 'success', description: `Codex found nothing on ${head}` };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function evaluatePullRequest(repo, number) {
  const pullRequest = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`]));
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`]));
  const review = parseCodexReview(pages.flat());
  const headSha = pullRequest.head.sha;
  return {
    headSha,
    targetUrl: review?.url ?? pullRequest.html_url,
    verdict: decideGate({ author: pullRequest.user.login, headSha, review })
  };
}

function publishStatus(repo, { headSha, targetUrl, verdict }) {
  gh([
    'api',
    '-X',
    'POST',
    `repos/${repo}/statuses/${headSha}`,
    '-f',
    `state=${verdict.state}`,
    '-f',
    `context=${STATUS_CONTEXT}`,
    '-f',
    `description=${verdict.description}`,
    '-f',
    `target_url=${targetUrl}`
  ]);
}

function main(env) {
  const repo = env.GITHUB_REPOSITORY;
  const number = env.PULL_REQUEST;
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  if (!/^\d+$/.test(number ?? '')) throw new Error(`PULL_REQUEST must be a pull request number, got "${number}"`);
  const evaluation = evaluatePullRequest(repo, number);
  publishStatus(repo, evaluation);
  console.log(
    `${STATUS_CONTEXT} on ${repo}#${number} at ${evaluation.headSha.slice(0, 7)}: ${evaluation.verdict.state}, ${evaluation.verdict.description}`
  );
}

if (require.main === module) {
  main(process.env);
}

module.exports = { STATUS_CONTEXT, parseCodexReview, decideGate, evaluatePullRequest };
