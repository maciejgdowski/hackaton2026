// Shown to the players in a vote (they were touching phones when it was called).
// Pick who to vote out or skip; you can change your mind until the timer runs out.

interface VotePlayer {
  id: string;
  name: string;
  alive: boolean;
}

interface VotePanelProps {
  players: VotePlayer[];
  myId: string;
  clues: string[]; // players I know are not the killer
  secondsLeft: number;
  needed: number;
  voted: number;
  participants: number;
  myVote: string | null; // player id, "skip" or null (not voted yet)
  onVote: (targetId: string | null) => void;
}

export default function VotePanel({ players, myId, clues, secondsLeft, needed, voted, participants, myVote, onVote }: VotePanelProps) {
  const living = players.filter((player) => player.alive);

  return (
    <div className="game-panel">
      <div className="card">
        <h3 style={{ margin: 0 }}>Vote · <span style={{ fontFamily: "var(--tm-font-mono)" }}>{secondsLeft}s</span></h3>
        <p style={{ fontSize: "0.75rem", margin: "0.5cqh 0 1.5cqh" }}>
          {needed} votes on the same player puts them out · {voted}/{participants} voted
        </p>

        {living.map((player) => (
          <div className="game-panel-row" key={player.id}>
            <p>
              {player.name}
              {player.id === myId ? " (you)" : ""}
              {clues.includes(player.id) && <span className="chip" style={{ marginLeft: "2cqw" }}>Clean</span>}
            </p>
            <button
              data-variant={myVote === player.id ? "primary" : undefined}
              onClick={() => onVote(player.id)}
            >
              {myVote === player.id ? "Voted" : "Vote"}
            </button>
          </div>
        ))}

        <button
          style={{ marginTop: "2cqh", width: "50cqw" }}
          data-variant={myVote === "skip" ? "primary" : undefined}
          onClick={() => onVote(null)}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
