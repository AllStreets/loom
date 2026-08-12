import { useEffect, useRef, useState } from "react";
import { organList, organRead, organGrant, type OrganEntry } from "../core";
import { manifestGuard, type OrganManifest } from "../loom/validate";
import { makeLoomApi } from "./api";

type OrganState = {
  entry: OrganEntry;
  manifest: OrganManifest;
  granted: string[];
  approved: boolean;
  error: string | null;
};

function PermissionCard({
  state,
  onApprove,
}: {
  state: OrganState;
  onApprove: () => void;
}) {
  const { manifest } = state;
  return (
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: "16px 20px",
        marginBottom: 12,
      }}
    >
      <div style={{ fontWeight: 600, color: "var(--t1)", marginBottom: 4 }}>
        {manifest.name}
      </div>
      <div style={{ color: "var(--t2)", fontSize: 13, marginBottom: 12 }}>
        {manifest.description}
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: "var(--t3)", fontSize: 12, marginBottom: 6 }}>
          Requested permissions:
        </div>
        {manifest.permissions.map((p) => (
          <div
            key={p}
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 12,
              color: "var(--t2)",
              padding: "2px 0",
            }}
          >
            {p}
          </div>
        ))}
      </div>
      <button
        onClick={onApprove}
        style={{
          background: "var(--accent)",
          color: "#000",
          border: "none",
          borderRadius: 4,
          padding: "6px 16px",
          fontWeight: 600,
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        Approve
      </button>
    </div>
  );
}

function OrganCard({
  state,
  onMount,
}: {
  state: OrganState;
  onMount: (el: HTMLDivElement) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on organ id; onMount identity changes every parent render
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren();
    onMount(el);
  }, [state.entry.id]);

  return (
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: "16px 20px",
        marginBottom: 12,
      }}
    >
      <div style={{ fontWeight: 600, color: "var(--t1)", marginBottom: 4 }}>
        {state.manifest.name}
      </div>
      <div style={{ color: "var(--t2)", fontSize: 13, marginBottom: 8 }}>
        {state.manifest.description}
      </div>
      {state.error && (
        <div
          style={{
            color: "var(--danger)",
            fontFamily: "var(--f-mono)",
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          {state.error}
        </div>
      )}
      <div ref={ref} />
    </div>
  );
}

export default function OrganHost() {
  const [organs, setOrgans] = useState<OrganState[] | null>(null);

  async function load() {
    const entries = await organList();
    const states: OrganState[] = [];
    for (const entry of entries) {
      const result = manifestGuard(entry.manifest);
      if (!result.ok) continue;
      const manifest = result.manifest;
      let granted: string[] = [];
      try {
        granted = JSON.parse(entry.granted ?? "[]");
      } catch {
        granted = [];
      }
      const approved = manifest.permissions.every((p) => granted.includes(p));
      states.push({ entry, manifest, granted, approved, error: null });
    }
    setOrgans(states);
  }

  useEffect(() => {
    load();
    const handler = () => load();
    window.addEventListener("organs-changed", handler);
    return () => window.removeEventListener("organs-changed", handler);
  }, []);

  async function handleApprove(state: OrganState) {
    await organGrant(state.entry.id, JSON.stringify(state.manifest.permissions));
    load();
  }

  function handleMount(state: OrganState, el: HTMLDivElement) {
    (async () => {
      try {
        const code = await organRead(state.entry.id, "organ.js");
        const blob = new Blob([code], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        try {
          const mod = await import(/* @vite-ignore */ url);
          mod.default.render(el, makeLoomApi(state.entry.id, state.granted));
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch (err) {
        setOrgans((prev) =>
          prev
            ? prev.map((o) =>
                o.entry.id === state.entry.id
                  ? { ...o, error: String(err) }
                  : o
              )
            : prev
        );
      }
    })();
  }

  if (organs === null) {
    return (
      <div style={{ color: "var(--t3)", fontSize: 13, padding: "16px 0" }}>
        Loading...
      </div>
    );
  }

  if (organs.length === 0) {
    return (
      <div style={{ color: "var(--t3)", fontSize: 13, padding: "16px 0" }}>
        No organs yet. Ask the Loom to build one.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      {organs.map((state) =>
        state.approved ? (
          <OrganCard
            key={state.entry.id}
            state={state}
            onMount={(el) => handleMount(state, el)}
          />
        ) : (
          <PermissionCard
            key={state.entry.id}
            state={state}
            onApprove={() => handleApprove(state)}
          />
        )
      )}
    </div>
  );
}
