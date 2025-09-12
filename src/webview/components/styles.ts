import type React from 'react';

export const commonButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 4,
  border: '1px solid var(--vscode-button-border, transparent)',
  background: 'var(--vscode-button-background)',
  color: 'var(--vscode-button-foreground)',
  cursor: 'pointer'
};

// Shared form control styles for consistent look across webviews
export const selectStyle: React.CSSProperties = {
  background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
  color: 'var(--vscode-dropdown-foreground, var(--vscode-input-foreground))',
  border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border))',
  padding: '2px 6px',
  borderRadius: 4
};

export const inputStyle: React.CSSProperties = {
  minWidth: 140,
  padding: '4px 8px',
  borderRadius: 4,
  border: '1px solid var(--vscode-input-border)',
  background: 'var(--vscode-input-background)',
  color: 'var(--vscode-input-foreground)'
};
