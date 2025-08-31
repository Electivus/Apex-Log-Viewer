export default {
  extends: ['@commitlint/config-conventional'],
  // Ignore automated commits from bots like Dependabot that include long link lines
  // in the body and do not follow our manual wrapping rules.
  ignores: [
    (message) => /Signed-off-by:\s*dependabot\[bot\]/i.test(message) || /^Bumps\s+\[?@?[^\s]+/i.test(message)
  ]
};
