async function returnsPromise(): Promise<number> {
  return 1;
}

function run(): void {
  returnsPromise();
}

run();
