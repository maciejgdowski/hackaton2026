import "./Style.css";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";

import MapBackground from "./MapBackground";
import { getPlaceName, getSavedLocation, requestLocation } from "./Location";

interface LobbySummary {
  id: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
}

function App() {
  const userName = localStorage.getItem("username");
  const navigate = useNavigate();
  const [lobbies, setLobbies] = useState<LobbySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

  // no username yet -> set one first
  useEffect(() => {
    if (!userName) navigate("/");
  }, [userName, navigate]);

  useEffect(() => {
    let isCurrent = true;
    setIsLoading(true);
    setError("");

    // You only see lobbies whose play area you are standing in.
    requestLocation()
      .catch(() => getSavedLocation())
      .then((location) => {
        if (!location) throw new Error("Allow location access to see the lobbies around you.");
        const params = new URLSearchParams({
          lat: String(location.lat),
          lng: String(location.lng),
          accuracy: String(location.accuracy ?? 0),
          userId: localStorage.getItem("userId") ?? "",
        });
        return fetch(`${API_URL}/lobbies?${params}`);
      })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load lobbies (${response.status}).`);
        return (await response.json()) as LobbySummary[];
      })
      .then((data) => {
        if (isCurrent) setLobbies(data);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) setError(requestError instanceof Error ? requestError.message : "Could not load lobbies.");
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [API_URL, refreshKey]);

  return (
    <>
      <div className="card" style={{ cursor: "pointer" }} onClick={() => navigate("/")}><p>Hello, {userName}!</p></div>
      <p style={{ marginLeft: "1cqw", marginTop: "0.1cqh", fontSize: "0.75rem", fontFamily: "var(--tm-font-mono)" }}>{getPlaceName()}</p>

      <div className="main">
        <div className="card" style={{ width: "70cqw" }}>
          <h4>Lobbies</h4>
          <div className="list" style={{ paddingBottom: "1cqh" }}>
            {isLoading && <p>Loading lobbies...</p>}
            {error && (
              <div role="alert">
                <p>{error}</p>
                <button onClick={() => setRefreshKey((current) => current + 1)}>Retry</button>
              </div>
            )}
            {!isLoading && !error && lobbies.length === 0 && <p>No open lobbies yet.</p>}
            {!isLoading && !error && lobbies.map((lobby) => (
              <LobbyTile key={lobby.id} {...lobby} />
            ))}
          </div>
          <hr style={{ marginBottom:"2cqh" }}></hr>
          {!isLoading && !error && <button onClick={() => setRefreshKey((current) => current + 1)}style={{ marginBottom:"3cqh" }}>Refresh lobbies</button>}
        </div>
        <button className="create-button" onClick={() => navigate("/create")}>Create Lobby</button>
      </div>
      <MapBackground />
    </>
  );
}

interface LobbyTileProps {
  id: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
}

function LobbyTile({ id, name, playerCount, maxPlayers }: LobbyTileProps) {
  const navigate = useNavigate();

  return (
    <>
      <hr />
      <div className="element">
        <p>{name} · {playerCount}/{maxPlayers} players</p>
        <button style={{ height: "5cqh" }} disabled={playerCount >= maxPlayers} onClick={() => navigate(`/lobby/${id}`)}>
          {playerCount >= maxPlayers ? "Full" : "Join"}
        </button>
      </div>
    </>
  );
}

export default App;
