# Webview Utilities

## `useVsCodeMessaging`

`useVsCodeMessaging` simplifies communication between the React webview and the
extension host.

```ts
import { useVsCodeMessaging } from './hooks/useVsCodeMessaging';

const postMessage = useVsCodeMessaging(msg => {
  // handle messages from the extension
});

postMessage({ type: 'ready' });
```

The hook wires up a `message` listener on mount and returns a typed
`postMessage` helper for sending `WebviewToExtensionMessage` objects back to the
extension. It automatically cleans up the listener on unmount so other webview
components can reuse it without boilerplate.
