import { useEffect, useState } from "react";
import { fleetStatus, timelineInit, timelineLog, type RoleStatus, type Commit } from "../lib/core";

export default function StatusPanel() {
  const [roles, setRoles] = useState<RoleStatus[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await timelineInit();
        setRoles(await fleetStatus());
        setCommits(await timelineLog(5));
      } catch (e) { setErr(String(e)); }
    })();
  }, []);

  return (
    <section style={{ marginTop: 20, maxWidth: 640 }}>
      <div style={{ fontFamily: "var(--f-mono)", color: "var(--t3)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".08em" }}>Fleet</div>
      {roles.map((r) => (
        <div key={r.role} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.present ? "var(--go)" : "var(--danger)" }} />
          <b style={{ minWidth: 92 }}>{r.role}</b>
          <span style={{ fontFamily: "var(--f-mono)", color: "var(--t2)", fontSize: 13 }}>{r.model}</span>
        </div>
      ))}
      <div style={{ fontFamily: "var(--f-mono)", color: "var(--t3)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".08em", marginTop: 16 }}>Timeline</div>
      {commits.length === 0 && <div style={{ color: "var(--t3)" }}>No commits yet.</div>}
      {commits.map((c) => (
        <div key={c.sha} style={{ fontSize: 13, padding: "3px 0" }}>
          <span style={{ fontFamily: "var(--f-mono)", color: "var(--t3)" }}>{c.sha.slice(0, 7)}</span>{" "}
          <span style={{ color: "var(--t1)" }}>{c.message}</span>
        </div>
      ))}
      {err && <div style={{ color: "var(--danger)", marginTop: 10 }}>{err}</div>}
    </section>
  );
}
