// One row per permission, each with its own Allow button.
// (iPhone Safari drops prompts when one tap asks for several things at once.)

import { useState } from "react";
import { askLocation, askMicrophone, askMotion, BLOCKED_HELP } from "./Permissions";
import type { PermissionsStatus, PermissionState } from "./Permissions";

interface PermissionsPanelProps {
  status: PermissionsStatus;
  onChange: (status: PermissionsStatus) => void;
  onClose: () => void;
  onContinue?: () => void; // shown when the panel was opened by Enter
}

const ROWS: { key: keyof PermissionsStatus; label: string; why: string }[] = [
  { key: "microphone", label: "Microphone", why: "Sonar: hears phones next to you" },
  { key: "location", label: "Location", why: "Map and nearby lobbies" },
  { key: "motion", label: "Motion", why: "Compass and floating map (optional)" },
];

function chipText(state: PermissionState) {
  if (state === "allowed") return "✓ On";
  if (state === "denied") return "✗ Blocked";
  if (state === "unsupported") return "n/a";
  return "Off";
}

export default function PermissionsPanel({ status, onChange, onClose, onContinue }: PermissionsPanelProps) {
  const [asking, setAsking] = useState<keyof PermissionsStatus | null>(null);

  // Called straight from the Allow tap, so the phone shows its prompt
  async function allow(key: keyof PermissionsStatus) {
    if (asking) return;
    setAsking(key);
    let result: PermissionState;
    if (key === "microphone") result = await askMicrophone();
    else if (key === "location") result = await askLocation();
    else result = await askMotion();
    setAsking(null);
    onChange({ ...status, [key]: result });
  }

  const ready = status.microphone === "allowed" && status.location === "allowed";

  return (
    <div className="game-panel" onClick={onClose}>
      <div className="card" onClick={(event) => event.stopPropagation()}>
        <h3 style={{ margin: 0 }}>Permissions</h3>
        <p style={{ fontSize: "0.75rem", margin: "0.5cqh 0 1.5cqh" }}>Tap Allow on each one, one at a time.</p>

        {ROWS.map((row) => (
          <div key={row.key} style={{ borderBottom: "1px solid var(--tm-border-subtle)" }}>
            <div className="game-panel-row" style={{ borderBottom: "none" }}>
              <div style={{ textAlign: "left" }}>
                <p>{row.label}</p>
                <p style={{ fontSize: "0.7rem", color: "var(--tm-text-muted)" }}>{row.why}</p>
              </div>
              {status[row.key] === "ask" ? (
                <button onClick={() => allow(row.key)} disabled={asking !== null}>
                  {asking === row.key ? "..." : "Allow"}
                </button>
              ) : (
                <span className="chip">{chipText(status[row.key])}</span>
              )}
            </div>
            {status[row.key] === "denied" && (
              <p className="permission-help">{BLOCKED_HELP}</p>
            )}
          </div>
        ))}

        <div style={{ display: "flex", gap: "3cqw", justifyContent: "center", marginTop: "2cqh" }}>
          {onContinue ? (
            <button data-variant={ready ? "primary" : undefined} onClick={onContinue}>
              {ready ? "Continue" : "Continue anyway"}
            </button>
          ) : (
            <button onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}
