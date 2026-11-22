import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let displayMessage = error?.message || 'An unexpected error occurred.';
    try {
      const parsed = JSON.parse(displayMessage) as { error?: string; operationType?: string };
      if (parsed && typeof parsed.error === 'string') {
        displayMessage = parsed.error;
      }
    } catch {
      // Keep plain string error message
    }
    return { hasError: true, message: displayMessage };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Application ErrorBoundary caught an error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen w-full items-center justify-center bg-white px-6 text-[#111827]">
          <div className="w-full max-w-md rounded-2xl border border-[#E5E7EB] bg-white p-8 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-[#FECACA] bg-[#FEF2F2] text-[#DC2626]">
              <AlertCircle className="h-5 w-5" />
            </div>
            <h1 className="mt-4 text-lg font-semibold text-[#111827]">Something went wrong</h1>
            <p className="mt-2 break-words text-xs leading-relaxed text-[#6B7280]">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#312E81] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#27246A]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Reload Workspace</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
