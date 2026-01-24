import React from 'react';

// Types used by tail view helpers
export type ParsedApexLine = {
  time?: string;
  nanos?: string;
  category?: string;
  tokens: string[];
  debugMessage?: string;
};

export type StyleRule = { regex: RegExp; style: React.CSSProperties };

export function apexLineStyle(line: string, enabled: boolean): React.CSSProperties {
  if (!enabled) {
    return { color: 'inherit' };
  }
  const s = line.toUpperCase();
  // Log-level header/config lines
  if (s.startsWith('APEX_CODE,') || /\d+\.\d+\s+APEX_CODE,/.test(s)) {
    return { color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' };
  }
  // Strong error signals
  if (s.includes('FATAL_ERROR') || s.includes('|EXCEPTION|') || s.includes('EXCEPTION_THROWN')) {
    return { color: 'var(--vscode-errorForeground)', fontWeight: 600 };
  }
  // User debug
  if (s.includes('|USER_DEBUG|') || (s.includes('|DEBUG|') && s.includes('USER_DEBUG'))) {
    return { color: 'var(--vscode-charts-blue)' };
  }
  // SOQL
  if (s.includes('SOQL_EXECUTE_') || s.includes('|SOQL|') || s.includes('QUERY_MORE')) {
    return { color: 'var(--vscode-charts-yellow)' };
  }
  // DML
  if (s.includes('DML_BEGIN') || s.includes('DML_END') || s.includes('|DML|')) {
    return { color: 'var(--vscode-charts-green)' };
  }
  // Callouts / HTTP
  if (s.includes('CALLOUT_') || s.includes('|CALLOUT|') || s.includes('|HTTP|')) {
    return { color: 'var(--vscode-charts-orange, #d19a66)' };
  }
  // Limits and cumulative summaries
  if (s.includes('LIMIT_USAGE') || s.includes('CUMULATIVE_LIMIT_USAGE') || s.includes('CUMULATIVE_PROFILING')) {
    return { color: 'var(--vscode-charts-orange, #d19a66)' };
  }
  // Code unit boundaries
  if (s.includes('CODE_UNIT_STARTED') || s.includes('CODE_UNIT_FINISHED') || s.includes('|CODE_UNIT|')) {
    return { color: 'var(--vscode-charts-purple, #b400ff)' };
  }
  // Method/system entry/exit and execution markers: deemphasize
  if (
    s.includes('METHOD_ENTRY') ||
    s.includes('METHOD_EXIT') ||
    s.includes('SYSTEM_METHOD_ENTRY') ||
    s.includes('SYSTEM_METHOD_EXIT') ||
    s.includes('EXECUTION_STARTED') ||
    s.includes('EXECUTION_FINISHED')
  ) {
    return { color: 'var(--vscode-descriptionForeground, #8a8a8a)' };
  }
  // Workflow / Flow / Validation markers
  if (s.includes('FLOW_')) {
    return { color: 'var(--vscode-charts-blue, #2bbac5)' };
  }
  if (s.includes('WF_') || s.includes('|WORKFLOW|')) {
    return { color: 'var(--vscode-charts-purple, #ff7ee7)' };
  }
  if (s.includes('VALIDATION_RULE') || s.includes('VALIDATION_')) {
    return { color: '#ff79c6' };
  }
  return { color: 'inherit' };
}

export function parseApexLine(line: string): ParsedApexLine {
  const parts = line.split('|');
  const head = parts[0] ?? '';
  const m = head.match(/^(\d{2}:\d{2}:\d{2}\.\d+)\s*\((\d+)\)\s*$/);
  const time = m ? m[1] : undefined;
  const nanos = m ? m[2] : undefined;
  const category = parts.length > 1 ? parts[1] : undefined;
  let debugMessage: string | undefined;
  if ((category ?? '').toUpperCase().includes('USER_DEBUG')) {
    const idxDebug = parts.findIndex(p => p.trim().toUpperCase() === 'DEBUG');
    if (idxDebug >= 0 && idxDebug + 1 < parts.length) {
      debugMessage = parts.slice(idxDebug + 1).join('|');
    }
  }
  return {
    time,
    nanos,
    category: category?.trim(),
    tokens: parts.slice(2),
    debugMessage
  };
}

export function categoryStyle(cat: string | undefined, line: string): React.CSSProperties {
  if (!cat) {
    return {};
  }
  const s = cat.toUpperCase();
  const lineUpper = line.toUpperCase();
  if (s.includes('EXCEPTION') || s.includes('FATAL')) {
    return { color: 'var(--vscode-errorForeground)', fontWeight: 600 };
  }
  if (s.includes('USER_DEBUG') || s === 'DEBUG') {
    return { color: 'var(--vscode-charts-blue)' };
  }
  if (s.includes('SOQL') || lineUpper.includes('QUERY_MORE')) {
    return { color: 'var(--vscode-charts-yellow)' };
  }
  if (s.includes('DML')) {
    return { color: 'var(--vscode-charts-green)' };
  }
  if (s.includes('USER_INFO')) {
    return { color: 'var(--vscode-terminal-ansiBrightCyan)' };
  }
  if (s.includes('CALLOUT') || s.includes('HTTP')) {
    return { color: 'var(--vscode-charts-orange, #d19a66)' };
  }
  if (
    s.includes('LIMIT') ||
    lineUpper.includes('CUMULATIVE_LIMIT_USAGE') ||
    lineUpper.includes('CUMULATIVE_PROFILING')
  ) {
    return { color: 'var(--vscode-charts-orange, #d19a66)' };
  }
  if (s.includes('CODE_UNIT')) {
    return { color: 'var(--vscode-charts-purple, #b400ff)' };
  }
  if (s.includes('FLOW')) {
    return { color: 'var(--vscode-charts-blue, #2bbac5)' };
  }
  if (s.includes('WORKFLOW') || s.startsWith('WF_')) {
    return { color: 'var(--vscode-charts-purple, #ff7ee7)' };
  }
  if (s.includes('VALIDATION')) {
    return { color: '#ff79c6' };
  }
  if (
    s.includes('METHOD_ENTRY') ||
    s.includes('METHOD_EXIT') ||
    s.includes('SYSTEM_METHOD_ENTRY') ||
    s.includes('SYSTEM_METHOD_EXIT') ||
    s.includes('EXECUTION_STARTED') ||
    s.includes('EXECUTION_FINISHED')
  ) {
    return { color: 'var(--vscode-descriptionForeground, #8a8a8a)' };
  }
  return {};
}

const StandardColors = {
  warning: { color: 'var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow))' },
  error: { color: 'var(--vscode-errorForeground)' },
  success: { color: 'var(--vscode-testing-iconPassed, var(--vscode-charts-green))' }
} as const;

export const contentHighlightRules: StyleRule[] = [
  { regex: /\|VARIABLE_\w*\|/g, style: { color: 'var(--vscode-terminal-ansiCyan)', fontWeight: 600 } },
  { regex: /\|METHOD_\w*\|/g, style: { color: 'var(--vscode-terminal-ansiBlue)' } },
  { regex: /\|SOQL_\w*\|/g, style: StandardColors.warning },
  { regex: /\|CONSTRUCTOR_\w*\|/g, style: { color: 'var(--vscode-terminal-ansiMagenta)' } },
  { regex: /\|USER\w*\|/g, style: StandardColors.success },
  // Fully-qualified names like Namespace.Class.method
  { regex: /\b([\w]+\.)+(\w)+\b/g, style: { color: 'var(--vscode-terminal-ansiBrightBlue)' } },
  { regex: /\b(DEBUG)\b/g, style: { color: 'var(--vscode-terminal-ansiCyan)', fontWeight: 600 } },
  { regex: /\b(HINT|INFO|INFORMATION|EXCEPTION_\w*|FATAL_\w*)\b/g, style: StandardColors.success },
  { regex: /\b(WARNING|WARN)\b/g, style: StandardColors.warning },
  { regex: /\b(ERROR|FAILURE|FAIL)\b/g, style: StandardColors.error },
  { regex: /\b([a-zA-Z.]*Exception)\b/g, style: StandardColors.error },
  { regex: /"[^"]*"/g, style: StandardColors.error },
  { regex: /\b([0-9]+|true|false|null)\b/g, style: { color: 'var(--vscode-terminal-ansiBrightBlue)' } },
  // SOQL keywords and explain/rows
  {
    regex: /\b(SELECT|FROM|WHERE|ORDER BY|GROUP BY|HAVING|LIMIT|OFFSET|ASC|DESC)\b/gi,
    style: { color: 'var(--vscode-terminal-ansiBrightYellow)' }
  },
  { regex: /\b(AND|OR|NOT|NULL)\b/gi, style: { color: 'var(--vscode-terminal-ansiYellow)' } },
  { regex: /\bRows:\d+\b/g, style: { color: 'var(--vscode-terminal-ansiBrightYellow)', fontWeight: 600 } },
  { regex: /\bAggregations:\d+\b/g, style: { color: 'var(--vscode-terminal-ansiBrightYellow)' } },
  { regex: /\b(TableScan|Index|Other)\b/g, style: { color: 'var(--vscode-terminal-ansiMagenta)' } },
  {
    regex: /\b(cardinality|sobjectCardinality|relativeCost)\b/g,
    style: { color: 'var(--vscode-terminal-ansiMagenta)' }
  },
  // Flow tokens and helpful markers
  {
    regex: /\b(FlowDecision|FlowAssignment|FlowInterview|FlowElement)\b/g,
    style: { color: 'var(--vscode-charts-purple, #b400ff)' }
  },
  // User info markers
  { regex: /\[(EXTERNAL|INTERNAL)\]/g, style: { color: 'var(--vscode-terminal-ansiCyan)' } },
  {
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    style: {
      color: 'var(--vscode-textLink-foreground, var(--vscode-terminal-ansiBrightCyan))',
      textDecoration: 'underline'
    }
  },
  // Misc helpful bits
  { regex: /\[\d+\]/g, style: { opacity: 0.6 } },
  { regex: /\bout of\b/g, style: { opacity: 0.7 } }
];

export function highlightContent(
  text: string,
  rules: StyleRule[]
): Array<{ text: string; style?: React.CSSProperties }> {
  let segments: Array<{ text: string; style?: React.CSSProperties }> = [{ text }];
  for (const rule of rules) {
    const next: Array<{ text: string; style?: React.CSSProperties }> = [];
    for (const seg of segments) {
      if (seg.style || !seg.text) {
        next.push(seg);
        continue;
      }
      const regex = new RegExp(
        rule.regex.source,
        rule.regex.flags.includes('g') ? rule.regex.flags : rule.regex.flags + 'g'
      );
      let lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(seg.text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        // Skip zero-length matches up-front to avoid fragmentation
        if (m[0].length === 0) {
          regex.lastIndex++;
          continue;
        }
        if (start > lastIndex) {
          next.push({ text: seg.text.slice(lastIndex, start) });
        }
        next.push({ text: m[0], style: rule.style });
        lastIndex = end;
      }
      if (lastIndex < seg.text.length) {
        next.push({ text: seg.text.slice(lastIndex) });
      }
    }
    segments = next;
  }
  return segments;
}
