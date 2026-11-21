import "./Style.css";
import { useNavigate, useParams } from "react-router-dom";
import MapBackground from "./MapBackground";
import { useEffect, useRef, useState } from "react";

interface LobbyState {
  id: string;
  name: string;
  props: {
    radius: "small" | "medium" | "large";
    center: { lat: number; lng: number };
    players: number;
    hunters: 1 | 2;
    clues: "easy" | "medium" | "hard";
  };
  members: Record<string, string>;
}

interface LobbyTileProps {
  name: string;
  id: string;
  role: "admin" | "user";
}

export default function Lobby() {
  const navigate = useNavigate();
  const { lobbyId } = useParams();
  const [lobbyData, setLobbyData] = useState<LobbyState | null>(null);
  const [userId, setUserId] = useState(localStorage.getItem("userId"));
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);
  const requestRef = useRef<{ lobbyId: string; promise: Promise<LobbyState> } | null>(null);
  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

  async function loadLobbyData(id: string): Promise<LobbyState> {
    let activeUserId = localStorage.getItem("userId");

    if (!activeUserId) {
      const userResponse = await fetch(`${API_URL}/getNewUser`);
      if (!userResponse.ok) {
        throw new Error(`Could not get a user ID (${userResponse.status}).`);
      }
      const userData = (await userResponse.json()) as { userId?: string };
      if (!userData.userId) throw new Error("The server did not return a user ID.");
      activeUserId = userData.userId;
      localStorage.setItem("userId", activeUserId);
    }

    const joinResponse = await fetch(
      `${API_URL}/lobby/${encodeURIComponent(id)}/join?userId=${encodeURIComponent(activeUserId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Player" }),
      }
    );
    if (!joinResponse.ok) {
      const data = (await joinResponse.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `Could not join lobby (${joinResponse.status}).`);
    }

    const response = await fetch(`${API_URL}/lobby/${encodeURIComponent(id)}`);
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `Could not load lobby (${response.status}).`);
    }
    setUserId(activeUserId);
    return (await response.json()) as LobbyState;
  }

  useEffect(() => {
    if (!lobbyId) {
      setError("No lobby ID was provided.");
      setIsLoading(false);
      return;
    }

    let isCurrent = true;
    setError("");
    setIsLoading(true);

    if (requestRef.current?.lobbyId !== lobbyId) {
      requestRef.current = { lobbyId, promise: loadLobbyData(lobbyId) };
    }

    requestRef.current.promise
      .then((data) => {
        if (isCurrent) setLobbyData(data);
      })
      .catch((requestError: unknown) => {
        if (isCurrent) {
          setError(requestError instanceof Error ? requestError.message : "Could not load lobby.");
        }
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [lobbyId, retryKey]);

  useEffect(() => {
    if (!lobbyId || !userId || isLoading || error) return;

    const socketUrl = new URL(API_URL);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.pathname = `/lobby/${encodeURIComponent(lobbyId)}`;
    socketUrl.search = new URLSearchParams({ userId }).toString();
    const socket = new WebSocket(socketUrl);

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type?: string; lobby?: LobbyState };
        if (message.type === "lobby:update" && message.lobby) {
          setLobbyData(message.lobby);
        } else if (message.type === "lobby:closed") {
          navigate("/");
        }
      } catch (messageError) {
        console.error("Could not read lobby update:", messageError);
      }
    };
    return () => socket.close();
  }, [lobbyId, userId, isLoading, error, navigate]);

  async function quitGame() {
    if (!lobbyId || !userId) {
      navigate("/");
      return;
    }
    try {
      const response = await fetch(
        `${API_URL}/lobby/${encodeURIComponent(lobbyId)}/leave?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) throw new Error(`Could not leave lobby (${response.status}).`);
      navigate("/");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not leave lobby.");
    }
  }

  async function disbandLobby() {
    if (!lobbyId || !userId) return;
    try {
      const response = await fetch(
        `${API_URL}/lobby/${encodeURIComponent(lobbyId)}?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Could not disband lobby (${response.status}).`);
      }
      navigate("/");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not disband lobby.");
    }
  }

  const members = Object.entries(lobbyData?.members ?? {});
  const isAdmin = members.length > 0 && members[0][0] === userId;

  return (
    <>
      <div className="card"><p>{isAdmin ? "You are the lobby admin" : "Waiting for host..."}</p></div>
      <p style={{ marginLeft: "1vw", marginTop: "0.1vh", fontSize: "0.75rem", fontFamily: "var(--tm-font-mono)" }}>United States - New York</p>

      <div className="main">
        <div className="card" style={{ width: "70vw" }}>
          <h4>{lobbyData?.name ?? "Lobby"} · Players ({members.length}{lobbyData ? `/${lobbyData.props.players}` : ""})</h4>
          <div className="list" style={{ paddingBottom: "1vh" }}>
            {isLoading && <p>Loading lobby...</p>}
            {error && (
              <div role="alert">
                <p>{error}</p>
                <button onClick={() => {
                  requestRef.current = null;
                  setRetryKey((current) => current + 1);
                }}>Retry</button>
              </div>
            )}
            {!isLoading && !error && members.map(([id, name], index) => (
              <PlayerTile key={id} id={id} name={name} role={index === 0 ? "admin" : "user"} />
            ))}
          </div>
          </div>
          {!isLoading && !error && (isAdmin ? (
            <div style={{ display: "flex", gap: "10vw" }}>
              <button style={{ width:"30vw", height:"10vh" }} onClick={disbandLobby}>Disband lobby</button>
              <button style={{ width:"30vw", height:"10vh" }} onClick={() => navigate(`/game/${lobbyId}`)}>Start game</button>
            </div>
          ) : (
            <div style={{ display: "flex",  gap: "10vw" }}>
              <button style={{ width:"30vw", height:"10vh" }} onClick={quitGame}>Quit lobby</button>
              <button style={{ width:"30vw", height:"10vh" }} type="button" disabled aria-live="polite">Waiting on host...</button>
            </div>
          ))}
      </div>
      <MapBackground />
    </>
  );
}

function PlayerTile({ name, id, role }: LobbyTileProps) {
  return (
    <>
      <hr />
      <div className="element">
        <p>{name}</p>
        <p style={{ fontSize: "0.75rem" }}>{role}{id === localStorage.getItem("userId") ? " (you)" : ""}</p>
      </div>
    </>
  );
}