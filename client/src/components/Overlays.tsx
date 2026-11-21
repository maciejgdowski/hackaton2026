// Full-screen overlays during a round.

/** You were taken out (or quit): SIGNAL LOST. */
export function DeadOverlay({ onWatch, onQuit }: { onWatch: () => void; onQuit: () => void }) {
  return (
    <div id="dead" className="overlay">
      <div className="mark glitch">SIGNAL<br />LOST</div>
      <p className="fine">You're out. The round goes on without you.</p>
      <button className="ghost" onClick={onWatch}>Watch</button>
      <button className="ghost" onClick={onQuit}>Quit game</button>
    </div>
  );
}

/** Audio needs a tap again (e.g. after a reload mid-round). */
export function ReconnectOverlay({ onTap }: { onTap: () => void }) {
  return (
    <button id="reconnect" className="overlay" onClick={onTap}>
      <span className="mark">TAP</span>
      <span className="fine">Reconnect sound + location</span>
    </button>
  );
}
