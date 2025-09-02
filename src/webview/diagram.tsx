import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DiagramGraph, DiagramMessage } from '../shared/diagramTypes';
import { DiagramView } from './components/diagram/DiagramView';

declare global {
  // Provided by VS Code webview runtime
  var acquireVsCodeApi: <T = unknown>() => { postMessage: (msg: T) => void };
}

const vscode = acquireVsCodeApi<DiagramMessage>();

function DiagramApp() {
  const [graph, setGraph] = useState<DiagramGraph | undefined>();

  useEffect(() => {
    // Apply styles for VS Code webview
    const style = document.createElement('style');
    style.id = 'apex-diagram-styles';
    style.textContent = `
      html, body, #root { height: 100%; }
      body { margin: 0; }
      #root { position: relative; }
    `;
    document.head.appendChild(style);

    // Listen for messages from extension
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data as DiagramMessage;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'graph') {
        setGraph(msg.graph || { nodes: [], sequence: [], nested: [] });
      }
    };

    window.addEventListener('message', handleMessage);

    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });

    return () => {
      window.removeEventListener('message', handleMessage);
      const existingStyle = document.getElementById('apex-diagram-styles');
      if (existingStyle) {
        existingStyle.remove();
      }
    };
  }, []);

  return <DiagramView graph={graph} />;
}

// Initialize React app
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('root');
  if (container) {
    const root = createRoot(container);
    root.render(<DiagramApp />);
  }
});
