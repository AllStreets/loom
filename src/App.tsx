import "./styles/tokens.css";

export default function App() {
  return (
    <main data-testid="loom-shell" style={{ minHeight: "100vh", padding: 24 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <b style={{ letterSpacing: ".4em", fontSize: 20 }}>LOOM</b>
        <small style={{ color: "var(--t3)", fontFamily: "var(--f-mono)" }}>
          sovereign console
        </small>
      </header>
    </main>
  );
}
