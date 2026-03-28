export const RUNTIME_CANCEL_EVENT = 'runtime/cancel';
export const RUNTIME_EXIT_EVENT = 'runtime/exit';
export const RUNTIME_RESTART_EVENT = 'runtime/restart';

export type RuntimeCancelEvent = {
  requestId: string;
};

export type RuntimeExitEvent = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type RuntimeRestartEvent = {
  delayMs: number;
};
