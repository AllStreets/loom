import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { RoleStatus } from "../lib/core";

// ---------------------------------------------------------------------------
// Fleet HUD — a persistent top-bar strip showing all three fleet roles
// (builder, companion, rewriter). Each role shows its name, model tag
// (ellipsis-truncated, full tag in title), a presence dot, and an ACTIVE
// state driven by `loom-fleet-activity` CustomEvents.
//
// This component does NOT poll fleetStatus itself — Shell owns the single
// poll loop and passes the RoleStatus[] down as `roles`.
// ---------------------------------------------------------------------------

type FleetRole = "builder" | "companion" | "rewriter";

const ROLE_ORDER: FleetRole[] = ["builder", "companion", "rewriter"];

const ROLE_COLORS: Record<FleetRole, string> = {
  builder: "#7dd3fc",
  companion: "#22d3ee",
  rewriter: "#a78bfa",
};

type FleetActivity = { role: FleetRole | null; phase?: string };

type Props = {
  roles: RoleStatus[];
};

export default function FleetHUD({ roles }: Props) {
  const reducedMotion = useReducedMotion() ?? false;
  const [active, setActive] = useState<FleetActivity>({ role: null });

  useEffect(() => {
    function onActivity(ev: Event) {
      const detail = (ev as CustomEvent<FleetActivity>).detail;
      if (!detail) return;
      setActive({ role: detail.role ?? null, phase: detail.phase });
    }
    window.addEventListener("loom-fleet-activity", onActivity);
    return () => window.removeEventListener("loom-fleet-activity", onActivity);
  }, []);

  // Fleet unreachable → single muted line. We treat "no roles at all" as
  // unreachable; presence-per-role is reflected on the dot, not here.
  const fleetOffline = roles.length === 0 || roles.every((r) => !r.present);

  if (fleetOffline) {
    return (
      <div
        data-testid="fleet-hud"
        style={{
          display: "flex",
          alignItems: "center",
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: "var(--t3)",
        }}
      >
        <span data-testid="fleet-offline">fleet offline</span>
      </div>
    );
  }

  // Index roles from fleetStatus by role name for model-tag lookup.
  const byRole = new Map<string, RoleStatus>();
  for (const r of roles) byRole.set(r.role, r);

  return (
    <div
      data-testid="fleet-hud"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      {ROLE_ORDER.map((role) => {
        const status = byRole.get(role);
        const present = status?.present ?? false;
        const model = status?.model || "absent";
        const color = ROLE_COLORS[role];
        const isActive = active.role === role;

        return (
          <div
            key={role}
            data-testid={`fleet-role-${role}`}
            data-active={isActive ? "true" : "false"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: 0,
            }}
          >
            {/* Presence dot + active pulse ring */}
            <span
              style={{
                position: "relative",
                display: "inline-flex",
                width: 8,
                height: 8,
                flexShrink: 0,
              }}
            >
              <span
                data-testid={`fleet-dot-${role}`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: present ? color : "var(--danger)",
                  display: "block",
                }}
              />
              {isActive && !reducedMotion && (
                <motion.span
                  data-testid={`fleet-pulse-${role}`}
                  aria-hidden
                  style={{
                    position: "absolute",
                    inset: -3,
                    borderRadius: "50%",
                    border: "1.5px solid var(--accent)",
                    pointerEvents: "none",
                  }}
                  initial={{ opacity: 0.7, scale: 0.8 }}
                  animate={{ opacity: [0.7, 0, 0.7], scale: [0.8, 1.6, 0.8] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                />
              )}
              {isActive && reducedMotion && (
                <span
                  data-testid={`fleet-pulse-${role}`}
                  aria-hidden
                  style={{
                    position: "absolute",
                    inset: -3,
                    borderRadius: "50%",
                    border: "1.5px solid var(--accent)",
                    pointerEvents: "none",
                  }}
                />
              )}
            </span>

            {/* Role name */}
            <span
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: isActive ? "var(--t1)" : "var(--t3)",
                flexShrink: 0,
              }}
            >
              {role}
            </span>

            {/* Model tag — ellipsis truncation, full tag in title */}
            <span
              title={model}
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                letterSpacing: ".02em",
                color: color,
                opacity: isActive ? 1 : 0.85,
                maxWidth: 120,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {model}
            </span>

            {/* Active role shows current phase text */}
            {isActive && active.phase && (
              <span
                data-testid={`fleet-phase-${role}`}
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 10,
                  letterSpacing: ".04em",
                  color: "var(--accent)",
                  maxWidth: 110,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {active.phase}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
