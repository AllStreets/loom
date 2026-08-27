import React from "react";
import { noteBootError } from "../lib/loom/recovery";

interface Props {
  zone: string;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Veto the boot-ok beacon (Finding 2): a boundaried crash is still a broken
    // boot. noteBootError only MATTERS during the boot window — markBootOk reads
    // it once, at settle — so always noting is safe and keeps this simple: a
    // later, post-boot boundary catch is harmless (the beacon already fired).
    noteBootError();
    console.debug("[ErrorBoundary] zone=" + this.props.zone, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          data-testid="error-boundary-fallback"
          data-zone={this.props.zone}
          style={{
            background: "var(--glass-raised, rgba(6,11,24,0.85))",
            border: "1px solid var(--glass-border, rgba(255,255,255,0.08))",
            borderRadius: 10,
            padding: "16px 20px",
            boxShadow: "var(--shadow-2, 0 4px 24px rgba(0,0,0,0.4))",
            backdropFilter: "blur(var(--blur, 12px))",
            WebkitBackdropFilter: "blur(var(--blur, 12px))",
          }}
        >
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: "var(--t2)",
              marginBottom: 8,
            }}
          >
            SHELL ERROR
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--t1)",
              marginBottom: 12,
            }}
          >
            Something broke in the shell — details in the console.
          </div>
          <button
            className="loom-reload-btn"
            onClick={() => window.location.reload()}
            style={{
              background: "rgba(255,255,255,0.08)",
              color: "var(--t1)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              padding: "5px 14px",
              fontFamily: "var(--f-mono)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            RELOAD
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
