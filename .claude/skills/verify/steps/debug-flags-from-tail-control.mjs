// Negative control for h.openDebugFlagsFromTail(): with every click on Tail's Debug Flags button intercepted,
// the helper must fail instead of returning an editor that was already open. It then opens normally again.
export default async function ({ h, expect }) {
  const first = await h.openDebugFlagsFromTail();
  const button = (await h.tailFrame()).getByTestId('tail-open-debug-flags').first();
  await button.evaluate(element => {
    window.__alvBlockedClicks = 0;
    window.__alvBlockClick = event => {
      window.__alvBlockedClicks += 1;
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    element.addEventListener('click', window.__alvBlockClick, { capture: true });
  });
  let intercepted;
  try {
    intercepted = await h.openDebugFlagsFromTail().then(
      frame => ({ returned: true, sameFrame: frame === first }),
      error => ({ returned: false, error: String(error.message).split('\n')[0] })
    );
  } finally {
    await button.evaluate(element => element.removeEventListener('click', window.__alvBlockClick, { capture: true }));
  }
  const blockedClicks = await button.evaluate(() => window.__alvBlockedClicks);
  expect(blockedClicks, 'the control intercepted at least one click').toBeGreaterThan(0);
  expect(
    intercepted.returned,
    `openDebugFlagsFromTail returned a Debug Flags frame (same as before: ${intercepted.sameFrame}) although all ${blockedClicks} clicks were intercepted`
  ).toBe(false);
  const reopened = await h.openDebugFlagsFromTail();
  return {
    blockedClicks,
    interceptedError: intercepted.error,
    reopenedOrg: (await reopened.getByTestId('debug-flags-org-select').innerText()).trim(),
    shot: await h.shot('debug-flags-from-tail-control', reopened)
  };
}
