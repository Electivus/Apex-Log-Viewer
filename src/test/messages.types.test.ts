import type { WebviewToExtensionMessage } from '../shared/messages';
import type { LogsMessage } from '../provider/logsMessageHandler';
import type { TailMessage } from '../provider/tailMessageHandler';

type AllHandled = LogsMessage | TailMessage;

type Assert<T extends true> = T;
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type _check = Assert<IsEqual<AllHandled, WebviewToExtensionMessage>>;

export {};
