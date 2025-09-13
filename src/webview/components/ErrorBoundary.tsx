import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  showReload?: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message?: string;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, message: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div role="alert" style={{ padding: 16 }}>
          <p>Something went wrong.</p>
          {this.state.message && <pre>{this.state.message}</pre>}
          {this.props.showReload && (
            <button type="button" onClick={this.handleReload}>
              Reload
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
