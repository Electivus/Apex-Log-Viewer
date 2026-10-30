export class AlvError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AlvError';
  }
}

export function abortError(): AlvError {
  return new AlvError('ABORTED', 'Operation cancelled.');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export async function awaitWithAbort<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return operation;

  const streamBacked = operation as PromiseLike<T> & {
    stream?: () => { destroy?: () => unknown };
  };
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => {
        try {
          streamBacked.stream?.().destroy?.();
        } catch {}
        reject(abortError());
      });
    };

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    );
    if (signal.aborted) onAbort();
  });
}
