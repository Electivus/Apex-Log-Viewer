import { getDefaultVsCodeApi, type VsCodeWebviewApi } from '../vscodeApi';

describe('getDefaultVsCodeApi', () => {
  afterEach(() => {
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    jest.restoreAllMocks();
  });

  it('stamps every posted object message with sentAt and passes the other fields through', () => {
    const posted: unknown[] = [];
    let savedState: unknown;
    const hostApi: VsCodeWebviewApi<any> = {
      postMessage: message => posted.push(message),
      getState: () => savedState as any,
      setState: state => {
        savedState = state;
      }
    };
    globalThis.acquireVsCodeApi = () => hostApi;
    jest.spyOn(Date, 'now').mockReturnValue(1_760_000_000_123);

    const api = getDefaultVsCodeApi<{ type: string; logId?: string }>();
    api.postMessage({ type: 'openLog', logId: '07L000000000001AAA' });
    api.setState({ query: 'abc' });

    expect(posted).toEqual([{ type: 'openLog', logId: '07L000000000001AAA', sentAt: 1_760_000_000_123 }]);
    expect(api.getState()).toEqual({ query: 'abc' });
  });
});
