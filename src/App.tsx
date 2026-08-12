import { useEffect } from "react";
import "./styles/tokens.css";
import StatusPanel from "./components/StatusPanel";
import Companion from "./components/Companion";
import OrganHost from "./lib/organs/host";
import { organList, organWrite } from "./lib/core";
import { installSeeds } from "./organs/seeds/install";

export default function App() {
  useEffect(() => {
    installSeeds({ list: organList, write: organWrite })
      .then((ids) => {
        if (ids.length) window.dispatchEvent(new CustomEvent("organs-changed"));
      })
      .catch((err) => {
        console.warn("[App] installSeeds failed:", err);
      });
  }, []);

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
