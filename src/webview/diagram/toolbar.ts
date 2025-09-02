import { h } from '../utils/dom';
import { styleByKind } from './styles';

interface ToolbarOptions {
  hideSystem: boolean;
  collapseRepeats: boolean;
  onHideSystemChange: (v: boolean) => void;
  onCollapseRepeatsChange: (v: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

export function createToolbar(opts: ToolbarOptions): HTMLElement {
  return h('div', { class: 'toolbar' }, [
    h('label', {}, [
      h(
        'input',
        {
          type: 'checkbox',
          checked: opts.hideSystem ? 'checked' : undefined,
          onchange: (e: any) => opts.onHideSystemChange(!!e.target.checked)
        },
        []
      ),
      ' Hide System'
    ]),
    h('label', {}, [
      h(
        'input',
        {
          type: 'checkbox',
          checked: opts.collapseRepeats ? 'checked' : undefined,
          onchange: (e: any) => opts.onCollapseRepeatsChange(!!e.target.checked)
        },
        []
      ),
      ' Collapse repeats'
    ]),
    h(
      'button',
      {
        onclick: () => opts.onExpandAll()
      },
      ['Expand all']
    ),
    h(
      'button',
      {
        onclick: () => opts.onCollapseAll()
      },
      ['Collapse all']
    ),
    h('div', { class: 'legend' }, [
      h('span', { class: 'item' }, [
        h('span', {
          class: 'swatch',
          style: { background: styleByKind('Trigger').fill, border: `1px solid ${styleByKind('Trigger').stroke}` }
        }),
        'Trigger'
      ]),
      h('span', { class: 'item' }, [
        h('span', {
          class: 'swatch',
          style: { background: styleByKind('Flow').fill, border: `1px solid ${styleByKind('Flow').stroke}` }
        }),
        'Flow'
      ]),
      h('span', { class: 'item' }, [
        h('span', {
          class: 'swatch',
          style: { background: styleByKind('Class').fill, border: `1px solid ${styleByKind('Class').stroke}` }
        }),
        'Class'
      ]),
      h('span', { class: 'item' }, [
        h('span', {
          class: 'swatch',
          style: { background: styleByKind('Other').fill, border: `1px solid ${styleByKind('Other').stroke}` }
        }),
        'Other'
      ])
    ])
  ]) as HTMLDivElement;
}
