// Your notebook: who you know is not the killer, who is out, and a short how-to-play.
// It looks the same for the killer and the seekers, so nobody can read a role off it.

interface CluesPlayer {
  id: string;
  name: string;
  alive: boolean;
  votedOut: boolean;
  role: "killer" | "seeker" | null;
}

interface CluesPanelProps {
  players: CluesPlayer[];
  myId: string;
  clues: string[];
  onClose: () => void;
}

export default function CluesPanel({ players, myId, clues, onClose }: CluesPanelProps) {
  function statusOf(player: CluesPlayer) {
    if (player.votedOut) return `Voted out · ${player.role === "killer" ? "Killer" : "Seeker"}`;
    if (!player.alive) return "Out";
    if (player.id === myId) return "You";
    if (clues.includes(player.id)) return "Clean";
    return "?";
  }

  return (
    <div className="game-panel" onClick={onClose}>
      <div className="card" onClick={(event) => event.stopPropagation()}>
        <h3 style={{ margin: 0 }}>Clues</h3>
        <p style={{ fontSize: "0.75rem", margin: "0.5cqh 0 1.5cqh" }}>
          {clues.length} {clues.length === 1 ? "player" : "players"} known not to be the killer
        </p>

        {players.map((player) => (
          <div className="game-panel-row" key={player.id}>
            <p style={{ textDecoration: player.alive ? "none" : "line-through" }}>{player.name}</p>
            <span className="chip">{statusOf(player)}</span>
          </div>
        ))}

        <p style={{ fontSize: "0.75rem", textAlign: "left", marginTop: "2cqh" }}>
          Download data at a point (A1, A2, A3), bring it to its tower (A) and upload it there. A tower with all 3 of
          its data names someone who is not the killer. Touch phones and press Share to swap clues.
          Enough players touching phones can call a vote. The killer kills by touching phones too.
        </p>
        <button onClick={onClose} style={{ width: "50cqw" }}>Close</button>
      </div>
    </div>
  );
}
