import React from 'react';

type IconButtonProps = {
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

const baseStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--vscode-testing-iconPassed, #3fb950)'
};

export function IconButton({ title, ariaLabel, disabled, onClick, children, style }: IconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel ?? title}
      onClick={onClick}
      disabled={disabled}
      style={{ ...baseStyle, ...style }}
    >
      {children}
    </button>
  );
}
