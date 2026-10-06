import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Without this, any render error unmounts the whole tree and leaves an empty
 * root — which, against a dark body, is an unexplained black window. A person
 * hitting that has no way to tell a crash from a hang, and no way back except
 * quitting the app.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; info: string | null }
> {
  override state = { error: null as Error | null, info: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error, info: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info: info.componentStack ?? null });
    console.error("[Bulletz] render error", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-title">Something broke while rendering</div>
          <p className="crash-body">
            The workspace itself is fine — this is the window, not your data. Reloading almost
            always fixes it.
          </p>
          <pre className="crash-detail">
            {this.state.error.message}
            {this.state.info ? `\n${this.state.info.split("\n").slice(0, 6).join("\n")}` : ""}
          </pre>
          <div className="crash-actions">
            <button className="send" onClick={() => window.location.reload()}>
              Reload
            </button>
            <button
              className="voice-ctl"
              onClick={() => void navigator.clipboard?.writeText(
                `${this.state.error?.stack ?? this.state.error?.message}\n${this.state.info ?? ""}`,
              )}
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
