import type { Config } from 'tailwindcss';
import { fontFamily } from 'tailwindcss/defaultTheme';
import animatePlugin from 'tailwindcss-animate';

const config: Config = {
  darkMode: ['class'],
  content: ['src/webview/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: {
        '2xl': '1400px'
      }
    },
    extend: {
      colors: {
        background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background, transparent))',
        foreground: 'var(--vscode-foreground)',
        card: 'var(--vscode-editorWidget-background, var(--vscode-editor-background, transparent))',
        'card-foreground': 'var(--vscode-foreground)',
        popover: 'var(--vscode-editorWidget-background, var(--vscode-editor-background, transparent))',
        'popover-foreground': 'var(--vscode-foreground)',
        border: 'var(--vscode-editorWidget-border, var(--vscode-input-border))',
        input: 'var(--vscode-input-background)',
        ring: 'var(--vscode-focusBorder)',
        primary: 'var(--vscode-button-background)',
        'primary-foreground': 'var(--vscode-button-foreground)',
        secondary: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background, transparent))',
        'secondary-foreground': 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
        muted: 'var(--vscode-tree-tableOddRowsBackground, var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.05)))',
        'muted-foreground': 'var(--vscode-descriptionForeground)',
        accent: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background, transparent))',
        'accent-foreground': 'var(--vscode-foreground)',
        destructive: 'var(--vscode-errorForeground)',
        'destructive-foreground': 'var(--vscode-editor-background, #000000)',
        success: 'var(--vscode-testing-iconPassed, #3fb950)',
        warning: 'var(--vscode-testing-iconQueued, #d29922)'
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      fontFamily: {
        sans: ['var(--vscode-font-family)', ...fontFamily.sans],
        mono: ['var(--vscode-editor-font-family)', ...fontFamily.mono]
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out'
      }
    }
  },
  plugins: [animatePlugin]
};

export default config;
