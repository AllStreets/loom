/**
 * ConsentCard.tsx — the one card that asks before LOOM's body changes.
 *
 * Written once and used twice, on purpose. The Companion renders it inline in
 * the conversation when the owner says "reweave yourself"; `BodyRequest.tsx`
 * renders the same card, shell-owned, when an ORGAN asks through the `self`
 * power. Round-1 review: an organ that could reach the swap directly meant the
 * grant card was doing work it was never a wall for. Now every path to the
 * body ends at this card, and only chrome acts on the answer.
 *
 * Accent-soft panel, uppercase-mono eyebrow and actions, calm lowercase line.
 * Tokens only, no exclamation marks (docs/BRAND.md).
 */

export type ConsentKind = "reweave_consent" | "thread_consent" | "generation_return_consent";

/** The affirmative each consent asks for — uppercase mono, the chrome voice. */
export const CONSENT_AFFIRMATIVE: Record<ConsentKind, string> = {
  reweave_consent: "REWEAVE",
  thread_consent: "THREAD",
  generation_return_consent: "RETURN",
};

/** The eyebrow above the line — which part of the body is being asked about. */
export const CONSENT_LABEL: Record<ConsentKind, string> = {
  reweave_consent: "reweave",
  thread_consent: "threads",
  generation_return_consent: "generations",
};

const actionStyle: React.CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 11,
  letterSpacing: ".12em",
  textTransform: "uppercase",
  padding: "6px 12px",
  borderRadius: 4,
  cursor: "pointer",
  background: "transparent",
};

export type ConsentCardProps = {
  consent: ConsentKind;
  /** The sentence the owner reads and hears. */
  line: string;
  /** null while the answer is still open. */
  settled: null | "confirmed" | "declined";
  /** A quieter second line — who asked, or what happened after. */
  note?: string;
  onChoose: (confirmed: boolean) => void;
};

export default function ConsentCard({ consent, line, settled, note, onChoose }: ConsentCardProps) {
  const affirmative = CONSENT_AFFIRMATIVE[consent];
  const label = CONSENT_LABEL[consent];
  return (
    <div
      data-testid={`consent-${consent}`}
      style={{
        flex: 1,
        background: "var(--accent-soft)",
        border: "1px solid rgba(34,211,238,0.22)",
        borderRadius: 8,
        padding: "12px 14px",
      }}
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          color: "var(--accent)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: "var(--t1)", lineHeight: 1.5, marginBottom: note ? 4 : 10 }}>
        {line}
      </div>
      {note && (
        <div
          data-testid="consent-note"
          style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5, marginBottom: 10 }}
        >
          {note}
        </div>
      )}
      {settled === null ? (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => onChoose(true)}
            style={{ ...actionStyle, color: "var(--accent)", border: "1px solid var(--accent)" }}
          >
            {affirmative}
          </button>
          <button
            type="button"
            onClick={() => onChoose(false)}
            style={{ ...actionStyle, color: "var(--t3)", border: "1px solid var(--line)" }}
          >
            NOT NOW
          </button>
        </div>
      ) : (
        <div
          style={{
            fontFamily: "var(--f-mono)",
            color: "var(--t3)",
            textTransform: "uppercase",
            letterSpacing: ".12em",
            fontSize: 10,
          }}
        >
          {settled === "confirmed" ? affirmative : "not now"}
        </div>
      )}
    </div>
  );
}
