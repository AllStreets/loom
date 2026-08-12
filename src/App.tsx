import "./styles/tokens.css";
import StatusPanel from "./components/StatusPanel";
import Companion from "./components/Companion";
import OrganHost from "./lib/organs/host";

export default function App() {
  return (
    <main data-testid="loom-shell" style={{ minHeight: "100vh", padding: 24 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <b style={{ letterSpacing: ".4em", fontSize: 20 }}>LOOM</b>
        <small style={{ color: "var(--t3)", fontFamily: "var(--f-mono)" }}>sovereign console</small>
      </header>
      <StatusPanel />
      <Companion />
      <OrganHost />
    </main>
  );
}
