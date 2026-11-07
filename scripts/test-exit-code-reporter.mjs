// Runs beside the spec reporter. When a test file's process dies, spec prints only 'test failed'; this line adds the
// exit code and signal, which is what tells a crash (0xC0000409 on Windows) from a failing assertion.
export default async function* exitCodes(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const { exitCode, signal } = event.data.details?.error ?? {};
    if (exitCode === undefined && signal === undefined) continue;
    const hex = typeof exitCode === 'number' ? ` (0x${(exitCode >>> 0).toString(16).toUpperCase()})` : '';
    yield `\n✖ ${event.data.name}: the test process exited with code ${exitCode}${hex}, signal ${signal}\n`;
  }
}
