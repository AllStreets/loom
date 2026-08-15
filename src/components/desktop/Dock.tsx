import { type OrganState } from "../../lib/organs/host";

type WindowInfo = { minimized: boolean; focused: boolean };

type Props = {
  organs: OrganState[];
  windowStates: Record<string, WindowInfo>;
  onTileClick: (id: string) => void;
};

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((w) => w[0].toUpperCase()).join("");
}

export default function Dock({ organs, windowStates, onTileClick }: Props) {
  const dockStyle: React.CSSProperties = {
    position: "fixed",
    bottom: 16,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    gap: 8,
    padding: "8px 12px",
    zIndex: 1000,
    background: "var(--glass)",
    backdropFilter: "blur(var(--blur))",
    WebkitBackdropFilter: "blur(var(--blur))",
    border: "1px solid var(--glass-border)",
    borderRadius: 14,
    pointerEvents: "auto",
  };

  return (
    <div style={dockStyle}>
      {organs.map((organ) => {
        const id = organ.entry.id;
        const ws = windowStates[id];
        const isMinimized = ws?.minimized ?? false;
        const isFocused = ws?.focused ?? false;
        const isOpen = !isMinimized;

        const tileStyle: React.CSSProperties = {
          position: "relative",
          width: 28,
          height: 28,
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 700,
          flexShrink: 0,
          background: isOpen
            ? "var(--accent-soft)"
            : "rgba(255,255,255,.06)",
          color: isOpen ? "var(--accent)" : "var(--t3)",
          border: "none",
          userSelect: "none",
          boxShadow: isFocused ? "0 0 0 1px var(--accent)" : undefined,
        };

        return (
          <div
            key={id}
            style={tileStyle}
            title={organ.manifest.name}
            onClick={() => onTileClick(id)}
          >
            {getInitials(organ.manifest.name)}
            {!organ.approved && (
              <span
                style={{
                  position: "absolute",
                  top: -2,
                  right: -2,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--accent)",
                  display: "block",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
