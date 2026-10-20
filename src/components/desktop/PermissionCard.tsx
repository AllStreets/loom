/**
 * PermissionCard.tsx — the card that asks before a new organ runs.
 *
 * It answers the three questions an owner actually has before saying yes:
 * what will this be able to do (each grant in plain language, with how much it
 * matters), what code will run (the organ's own files, readable in place), and
 * what checks it already passed. It says plainly that approval is consent and
 * not a sandbox: an approved organ runs in LOOM's own process.
 *
 * A real dialog: focus moves in and stays in, Escape is "Not now", focus goes
 * back to whatever opened it, and "Not now" holds focus first so a reflexive
 * Enter never grants anything.
 */
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { organRead } from "../../lib/core";
import { POWER_LABELS, type Power } from "../../lib/loom/validate";
import type { OrganState } from "../../lib/organs/host";

type Weight = "low" | "medium" | "high";

/** Plain-language storage/model/settings permissions (the powers live in POWER_LABELS). */
export const PERMISSION_LABELS: Record<string, string> = {
  storage: "keep its own data on this Mac",
  model: "send text to your local models",
  settings: "read and change LOOM's settings",
};

const WEIGHT: Record<string, Weight> = {
  storage: "low",
  model: "low",
  settings: "medium",
  timeline: "low",
  voice: "low",
  notify: "low",
  pulse: "medium",
  self: "high",
};

const WEIGHT_WORD: Record<Weight, string> = { low: "low", medium: "medium", high: "high" };
const WEIGHT_COLOR: Record<Weight, string> = { low: "var(--t2)", medium: "var(--warn)", high: "var(--danger)" };

export type Grant = { token: string; label: string; weight: Weight; kind: "permission" | "power" };

export function grantsFor(manifest: OrganState["manifest"]): Grant[] {
  const perms = manifest.permissions.map((p): Grant => ({
    token: p, label: PERMISSION_LABELS[p] ?? p, weight: WEIGHT[p] ?? "medium", kind: "permission",
  }));
  const powers = (manifest.powers ?? []).map((p): Grant => ({
    token: p, label: POWER_LABELS[p as Power] ?? p, weight: WEIGHT[p] ?? "medium", kind: "power",
  }));
  return [...perms, ...powers];
}

const eyebrow: React.CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: "var(--accent)",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--t1)",
  marginBottom: 8,
};

const btn: React.CSSProperties = {
  borderRadius: 6,
  padding: "8px 16px",
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "var(--f-sans)",
};

export type PermissionCardProps = {
  organ: OrganState;
  onApprove: () => void;
  onDismiss: () => void;
};

export default function PermissionCard({ organ, onApprove, onDismiss }: PermissionCardProps) {
  const rm = useReducedMotion() ?? false;
  const { manifest, entry } = organ;
  const grants = grantsFor(manifest);
  const [code, setCode] = useState<string | null>(null);
  const [tests, setTests] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const notNowRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    let alive = true;
    organRead(entry.id, "organ.js").then((t) => { if (alive) setCode(typeof t === "string" ? t : null); }).catch(() => {});
    organRead(entry.id, "test.js").then((t) => { if (alive) setTests(typeof t === "string" && t.trim() ? t : null); }).catch(() => {});
    return () => { alive = false; };
  }, [entry.id]);

  // focus in on open, back out on close
  useEffect(() => {
    openerRef.current = document.activeElement;
    notNowRef.current?.focus();
    return () => {
      const o = openerRef.current as HTMLElement | null;
      if (o && typeof o.focus === "function" && document.contains(o)) o.focus();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDismiss(); return; }
    if (e.key !== "Tab" || !boxRef.current) return;
    const f = Array.from(boxRef.current.querySelectorAll<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])"));
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }

  const lines = code ? code.split("\n").length : 0;
  const testCount = tests ? (tests.match(/\b(?:it|test)\s*\(/g) ?? []).length : 0;
  const titleId = `perm-title-${entry.id}`;
  const descId = `perm-desc-${entry.id}`;

  return (
    <motion.div
      ref={boxRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-testid="permission-card"
      onKeyDown={onKeyDown}
      initial={rm ? false : { opacity: 0, scale: 0.97, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={rm ? undefined : { opacity: 0, scale: 0.97, y: 10 }}
      transition={rm ? {} : { type: "spring", stiffness: 420, damping: 32 }}
      style={{
        background: "var(--glass-raised)",
        backdropFilter: "blur(var(--blur))",
        WebkitBackdropFilter: "blur(var(--blur))",
        border: "1px solid var(--glass-border)",
        boxShadow: "var(--shadow-2)",
        borderRadius: 14,
        padding: "22px 24px 20px",
        width: "min(480px, calc(100vw - 32px))",
        maxHeight: "calc(100vh - 48px)",
        overflowY: "auto",
        position: "relative",
      }}
    >
      <div style={eyebrow}>new organ · asks before it runs</div>
      <h2 id={titleId} style={{ fontSize: 18, fontWeight: 650, color: "var(--t1)", margin: "8px 0 4px", letterSpacing: "-.01em" }}>
        {manifest.name}
      </h2>
      <p id={descId} style={{ color: "var(--t2)", fontSize: 13, lineHeight: 1.55, margin: "0 0 18px", overflowWrap: "break-word" }}>
        {manifest.description}
      </p>

      <section aria-label="What it can do" style={{ marginBottom: 16 }}>
        <div style={sectionLabel}>If you approve, it can</div>
        {grants.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--t2)", margin: 0 }}>nothing beyond drawing in its own window.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--line)", borderRadius: 8 }}>
            {grants.map((g, i) => (
              <li
                key={g.token}
                data-testid={`grant-${g.token}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "baseline",
                  gap: 12,
                  padding: "9px 12px",
                  borderTop: i ? "1px solid var(--line)" : "none",
                }}
              >
                <span style={{ fontSize: 13, color: "var(--t1)", overflowWrap: "break-word" }}>{g.label}</span>
                <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: ".08em", color: WEIGHT_COLOR[g.weight], whiteSpace: "nowrap" }}>
                  {WEIGHT_WORD[g.weight]} impact
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="What will run" style={{ marginBottom: 16 }}>
        <div style={sectionLabel}>What will run</div>
        <div style={{ fontSize: 13, color: "var(--t2)", lineHeight: 1.55 }}>
          {code === null ? "Reading the organ's code…" : (
            <>
              <span style={{ fontFamily: "var(--f-mono)", fontSize: 12, color: "var(--t1)" }}>organ.js</span>, {lines} line{lines === 1 ? "" : "s"}.
              {tests && <> Before it was saved it passed LOOM's checks: a manifest check, a test render, and {testCount ? `its ${testCount} own test${testCount === 1 ? "" : "s"}` : "its own tests"}.</>}
            </>
          )}
        </div>
        {code !== null && (
          <>
            <button
              type="button"
              aria-expanded={showCode}
              onClick={() => setShowCode((v) => !v)}
              style={{ background: "none", border: "none", padding: "6px 0 0", color: "var(--accent)", fontSize: 12.5, cursor: "pointer", fontFamily: "var(--f-sans)" }}
            >
              {showCode ? "Hide the code" : "Read the code"}
            </button>
            {showCode && (
              <pre
                data-testid="organ-code"
                tabIndex={0}
                style={{
                  margin: "8px 0 0",
                  maxHeight: 220,
                  overflow: "auto",
                  background: "rgba(0,0,0,.35)",
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontFamily: "var(--f-mono)",
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  color: "var(--t2)",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {code}
              </pre>
            )}
          </>
        )}
      </section>

      <p style={{ fontSize: 12, color: "var(--t2)", lineHeight: 1.55, margin: "0 0 18px", padding: "10px 12px", background: "var(--accent-soft)", borderRadius: 8 }}>
        Approving is consent, not a sandbox: the organ runs inside LOOM with these grants. You can revoke any power from its window, undo this approval right after, or delete the organ.
      </p>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button
          ref={notNowRef}
          type="button"
          onClick={onDismiss}
          style={{ ...btn, background: "rgba(255,255,255,.04)", color: "var(--t1)", border: "1px solid var(--glass-border)" }}
        >
          Not now
        </button>
        <button
          type="button"
          onClick={onApprove}
          style={{ ...btn, background: "var(--accent)", color: "#03121a", border: "none", fontWeight: 650 }}
        >
          Approve and run
        </button>
      </div>
    </motion.div>
  );
}
