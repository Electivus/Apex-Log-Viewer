export function h(
  tag: string,
  attrs?: Record<string, any>,
  children?: (Node | string | null | undefined)[]
): HTMLElement | SVGElement {
  const svgTags = new Set(['svg', 'path', 'defs', 'marker', 'line', 'text', 'rect', 'g', 'title']);
  const htmlTags = new Set(['div', 'label', 'span', 'input', 'button']);
  const el = svgTags.has(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = (attrs as any)[k];
      if (k === 'style' && typeof v === 'object') Object.assign((el as HTMLElement).style, v);
      else if (k === 'class') (el as Element).setAttribute('class', String(v));
      else if (k.startsWith('on') && typeof v === 'function') (el as any)[k] = v;
      else if (v !== undefined && v !== null) {
        // Allowlist of safe attributes (prevents event/href/src injection and satisfies CodeQL)
        const allowed = new Set([
          'id',
          'class',
          'type',
          'checked',
          'viewBox',
          // Position/geometry
          'x',
          'y',
          'x1',
          'y1',
          'x2',
          'y2',
          'width',
          'height',
          'rx',
          'ry',
          // Styling
          'fill',
          'stroke',
          'stroke-width',
          'font-size'
        ]);
        if (allowed.has(k)) (el as any).setAttribute?.(k, String(v));
      }
    }
  }
  if (children)
    for (const c of children) {
      if (c === null || c === undefined) continue;
      if (typeof c === 'string') {
        el.appendChild(document.createTextNode(c));
      } else if (c instanceof Node) {
        // Only allow known-safe node types/tags
        if (c.nodeType === Node.TEXT_NODE) {
          el.appendChild(c);
        } else if (c instanceof SVGElement) {
          if (svgTags.has((c as Element).tagName.toLowerCase())) el.appendChild(c);
        } else if (c instanceof HTMLElement) {
          if (htmlTags.has((c as Element).tagName.toLowerCase())) el.appendChild(c);
        }
      }
    }
  return el;
}
