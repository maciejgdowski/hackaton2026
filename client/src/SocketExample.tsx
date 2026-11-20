import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

type SocketStatus = "connecting" | "connected" | "disconnected" | "error";
type LobbyResponse = {
  ok: boolean;
  lobbyId?: string;
  memberCount?: number;
  error?: string;
};

function SocketExample() {
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("connecting");
  const [connectedCount, setConnectedCount] = useState(0);
  const [lobbyId, setLobbyId] = useState("");
  const [lobbyInput, setLobbyInput] = useState("");
  const [lobbyMemberCount, setLobbyMemberCount] = useState(0);
  const [lobbyError, setLobbyError] = useState("");
  const [availableLobbies, setAvailableLobbies] = useState<string[]>([]);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(API_URL, {
      withCredentials: true,
    });
    socketRef.current = socket;

    const refreshLobbyList = () => {
      socket.emit("list_lobbies", (lobbyIds: string[]) => {
        setAvailableLobbies(lobbyIds);
      });
    };

    socket.on("connect", () => {
      setSocketStatus("connected");
      refreshLobbyList();
    });
    socket.on("disconnect", () => setSocketStatus("disconnected"));
    socket.on("socketCount", (count: number) => {
      setConnectedCount(count);
    });
    socket.on("lobby:count", (count: number) => {
      setLobbyMemberCount(count);
    });
    socket.on("connect_error", (error) => {
      console.error("Socket connection error:", error);
      setSocketStatus("error");
    });

    socket.on("lobbies:update", setAvailableLobbies);

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  const handleLobbyResponse = (response: LobbyResponse) => {
    if (!response.ok || !response.lobbyId) {
      setLobbyError(response.error ?? "Could not join the lobby.");
      return;
    }

    setLobbyError("");
    setLobbyId(response.lobbyId);
    setLobbyMemberCount(response.memberCount ?? 1);
  };

  const createLobby = () => {
    setLobbyError("");
    socketRef.current?.emit("create_lobby", handleLobbyResponse);
  };

  const joinLobby = (id = lobbyInput) => {
    setLobbyError("");
    socketRef.current?.emit("join_lobby", id, handleLobbyResponse);
  };

  const refreshLobbyList = () => {
    socketRef.current?.emit("list_lobbies", (lobbyIds: string[]) => {
      setAvailableLobbies(lobbyIds);
    });
  };

  return (
    <>
      <h1>Lobby demo</h1>
      <p>Socket status: {socketStatus}</p>
      <p>Connected clients: {connectedCount}</p>

      <button onClick={createLobby} disabled={socketStatus !== "connected"}>
        Create lobby
      </button>

      <div>
        <input
          value={lobbyInput}
          onChange={(event) => setLobbyInput(event.target.value)}
          placeholder="Enter lobby ID"
          aria-label="Lobby ID"
        />
        <button
          onClick={() => joinLobby()}
          disabled={socketStatus !== "connected" || !lobbyInput.trim()}
        >
          Join lobby
        </button>
      </div>

      <section>
        <h2>Available Lobbies</h2>
        <button onClick={refreshLobbyList} disabled={socketStatus !== "connected"}>
          Refresh list
        </button>
        {availableLobbies.length === 0 ? (
          <p>No active lobbies.</p>
        ) : (
          <ul>
            {availableLobbies.map((lobby) => (
              <li key={lobby}>
                {lobby}{" "}
                <button
                  onClick={() => joinLobby(lobby)}
                  disabled={socketStatus !== "connected"}
                >
                  Join
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {lobbyError && <p role="alert">{lobbyError}</p>}
      {lobbyId && (
        <section>
          <h2>Lobby</h2>
          <p>Lobby ID: {lobbyId}</p>
          <p>People in this lobby: {lobbyMemberCount}</p>
        </section>
      )}
    </>
  );
}

export default SocketExample;
