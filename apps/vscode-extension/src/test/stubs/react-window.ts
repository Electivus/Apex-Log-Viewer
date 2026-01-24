import React from 'react';

export type Align = 'auto' | 'center' | 'end' | 'smart' | 'start';

export type ListImperativeAPI = {
  readonly element: HTMLDivElement | null;
  scrollToRow: (opts: { align?: Align; behavior?: 'auto' | 'instant' | 'smooth'; index: number }) => void;
};

export function List(props: any) {
  // Minimal stub for TypeScript compile-time; runtime is proxyquired in tests
  return React.createElement('div', {
    ref: (el: HTMLDivElement | null) => {
      if (props.listRef) {
        const api = { element: el, scrollToRow: () => {} } as ListImperativeAPI;
        if (typeof props.listRef === 'function') props.listRef(api);
        else props.listRef.current = api;
      }
    }
  });
}
