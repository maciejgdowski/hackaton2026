import "./MapBackground";
import MapBackground from "./MapBackground";
import "./Style.css";
import { useNavigate } from "react-router-dom";
import "./LocationPickerMap";
import LocationPickerMap, { type Coordinates } from "./LocationPickerMap";
import { useState } from "react";

export default function Create() {
  const navigate = useNavigate();

  const [location, setLocation] = useState<Coordinates | null>(null);
  const [lobbyName, setLobbyName] = useState("");
  const [playerCount, setPlayerCount] = useState("2");
  const [hunterCount, setHunterCount] = useState("1");
  const [playerCountError, setPlayerCountError] = useState("");
  const [hunterCountError, setHunterCountError] = useState("");
  const [mapSize, setMapSize] = useState<"sm" | "md" | "lg">("md");
  const [clueDensity, setClueDensity] = useState<"sm" | "md" | "lg">("md");
  const [error, setError] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

  function validateCount(value: string, label: string, minimum: number, maximum: number) {
    if (!value.trim()) return `${label} is required.`;
    const parsedValue = Number(value);
    if (!Number.isInteger(parsedValue)) return `${label} must be a whole number.`;
    if (parsedValue < minimum || parsedValue > maximum) {
      return `${label} must be between ${minimum} and ${maximum}.`;
    }
    return "";
  }

  async function createLobby() {
    setError("");

    if (!lobbyName.trim()) {
      setError("Lobby name is required.");
      return;
    }
    if (!location) {
      setError("Select a location on the map.");
      return;
    }
    const nextPlayerCountError = validateCount(playerCount, "Player count", 2, 8);
    const nextHunterCountError = validateCount(hunterCount, "Hunter count", 1, 2);
    setPlayerCountError(nextPlayerCountError);
    setHunterCountError(nextHunterCountError);
    if (nextPlayerCountError || nextHunterCountError) return;

    setIsCreating(true);

    try {
      const storedUserId = localStorage.getItem("userId");
      const userResponse = await fetch(
        `${API_URL}/getNewUser${
          storedUserId ? `?userId=${encodeURIComponent(storedUserId)}` : ""
        }`
      );

      if (!userResponse.ok) {
        throw new Error(`Could not get a user ID (${userResponse.status})`);
      }

      const userData = (await userResponse.json()) as { userId?: string };
      if (!userData.userId) {
        throw new Error("The server did not return a user ID.");
      }

      localStorage.setItem("userId", userData.userId);

      const radiusMap = { sm: "small", md: "medium", lg: "large" } as const;
      const clueMap = { sm: "easy", md: "medium", lg: "hard" } as const;

      const lobbyResponse = await fetch(
        `${API_URL}/lobby/create?userId=${encodeURIComponent(userData.userId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            radius: radiusMap[mapSize],
            center: location,
            players: Number(playerCount),
            hunters: Number(hunterCount),
            clues: clueMap[clueDensity],
            username: lobbyName,
          }),
        }
      );

      if (!lobbyResponse.ok) {
        let message = `Could not create lobby (${lobbyResponse.status})`;
        try {
          const data = (await lobbyResponse.json()) as { error?: string };
          if (data.error) message = data.error;
        } catch {
          // Keep the HTTP status fallback.
        }
        throw new Error(message);
      }

      const lobbyData = (await lobbyResponse.json()) as { lobbyId?: string };
      if (!lobbyData.lobbyId) {
        throw new Error("The server did not return a lobby ID.");
      }

      navigate(`/lobby/${lobbyData.lobbyId}`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "An unexpected error occurred."
      );
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <>
      <div className="card">
        <p>Creating lobby</p>
      </div>
      <p
        style={{
          marginLeft: "1vw",
          marginTop: "0.1vh",
          fontSize: "0.75rem",
          fontFamily: "var(--tm-font-mono)",
        }}
      >
        United States - New York
      </p>

      <div className="main">
        <div className="card" style={{ width: "70vw" }}>
          <h4>Your Lobby</h4>
          {error && (
          <p role="alert" style={{ color: "#ff7070", margin: "0", padding: "0", fontSize:"0.75rem" }}>
            {error}
          </p>
        )}
          <div
            className="list"
            style={{ paddingBottom: "1vh", maxHeight: "50vh" }}
          >
            <hr></hr>
            <p className="annotation">Name:</p>{" "}
            <input
              style={{ width: "50vw" }}
              type="text"
              placeholder="name"
              value={lobbyName}
              onChange={(e) => setLobbyName(e.target.value)}
            ></input>
            <hr></hr>
            <p className="annotation">Player count:</p>{" "}
            <input
              style={{ width: "50vw" }}
              type="number"
              placeholder="2-8"
              step="1"
              value={playerCount}
              onChange={(e) => {
                const value = e.target.value;
                setPlayerCount(value);
                setPlayerCountError(validateCount(value, "Player count", 2, 8));
              }}
            ></input>
            {playerCountError && <p role="alert" style={{ color: "#ff7070", margin: "0", padding: "0", fontSize:"0.75rem" }}>{playerCountError}</p>}
            <hr></hr>
            <p className="annotation">Hunter count:</p>{" "}
            <input
              style={{ width: "50vw" }}
              type="number"
              placeholder="1-2"
              step="1"
              value={hunterCount}
              onChange={(e) => {
                const value = e.target.value;
                setHunterCount(value);
                setHunterCountError(validateCount(value, "Hunter count", 1, 2));
              }}
            ></input>
            {hunterCountError && <p role="alert" style={{ color: "#ff7070", margin: "0", padding: "0", fontSize:"0.75rem" }}>{hunterCountError}</p>}
            <hr></hr>
            <p className="annotation">Map size:</p>
            <select
              style={{ width: "50vw" }}
              value={mapSize}
              onChange={(e) =>
                setMapSize(e.target.value as "sm" | "md" | "lg")
              }
            >
              <option value="lg">Large</option>
              <option value="md">Medium (Default)</option>
              <option value="sm">Small</option>
            </select>
            <hr></hr>
            <p className="annotation">Clues:</p>
            <select
              style={{ width: "50vw" }}
              value={clueDensity}
              onChange={(e) =>
                setClueDensity(e.target.value as "sm" | "md" | "lg")
              }
            >
              <option value="lg">Dense</option>
              <option value="md">Normal (Default)</option>
              <option value="sm">Sparse</option>
            </select>
            <p className="annotation">Location</p>
            <LocationPickerMap value={location} onChange={setLocation} />
          </div>
        </div>
        <div style={{ display: "flex", gap: "10vw" }}>
          <button
            className="create-button"
            style={{ width: "30vw"}}
            onClick={() => navigate("/")}
          >
            Back
          </button>
          <button
            className="create-button"
            style={{ width: "30vw" }}
            onClick={createLobby}
            disabled={isCreating}
          >
            {isCreating ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
      <MapBackground />
    </>
  );
}