import "./MapBackground";
import MapBackground from "./MapBackground";
import "./Style.css";
import { useNavigate } from "react-router-dom";
import "./LocationPickerMap";
import LocationPickerMap, { type Coordinates } from "./LocationPickerMap";
import { useEffect, useRef, useState } from "react";
import { requestLocation } from "./Location";

// Same sizes as ZONE_RADIUS_M on the server (metres)
const ZONE_RADIUS_M = { sm: 150, md: 300, lg: 500 };

export default function Create() {
  const navigate = useNavigate();

  const [location, setLocation] = useState<Coordinates | null>(null);
  const [myLocation, setMyLocation] = useState<Coordinates | null>(null); // where I am (shown on the map)
  const pinPlaced = useRef(false);
  const [locationStatus, setLocationStatus] = useState("Finding your current location...");

  // Follow my GPS: the map shows where I am, and the pin starts there until I pick another point.
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationStatus("Location is unavailable. Choose a point on the map.");
      return;
    }
    const watchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const here = { lat: coords.latitude, lng: coords.longitude };
        setMyLocation(here);
        if (pinPlaced.current) return;
        setLocation(here);
        setLocationStatus("Using your current location. Click the map to choose another point.");
        pinPlaced.current = true; // only the first GPS fix moves the pin, after that it stays where it is
      },
      () => {
        if (pinPlaced.current) return;
        setLocationStatus("Could not get your location. Choose a point on the map.");
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);
  const [lobbyName, setLobbyName] = useState("");
  const [playerCount, setPlayerCount] = useState("2");
  const [playerCountError, setPlayerCountError] = useState("");
  const [mapSize, setMapSize] = useState<"sm" | "md" | "lg">("md");
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
    setPlayerCountError(nextPlayerCountError);
    if (nextPlayerCountError) return;

    setIsCreating(true);

    try {
      // You can only host where you are: the server checks you stand inside the play area.
      const hostLocation = await requestLocation().catch(() => {
        throw new Error("Allow location access: you have to be inside the play area to host.");
      });

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

      const lobbyResponse = await fetch(
        `${API_URL}/lobby/create?userId=${encodeURIComponent(userData.userId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            radius: radiusMap[mapSize],
            center: location,
            players: Number(playerCount),
            name: lobbyName,
            username: localStorage.getItem("username") ?? "Player",
            hostLocation,
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
          marginLeft: "1cqw",
          marginTop: "0.1cqh",
          fontSize: "0.75rem",
          fontFamily: "var(--tm-font-mono)",
        }}
      >
        Choose your lobby's starting location
      </p>

      <div className="main">
        <div className="card" style={{ width: "90cqw" }}>
          <h4>Your Lobby</h4>
          {error && (
          <p role="alert" style={{ color: "#ff7070", margin: "0", padding: "0", fontSize:"0.75rem" }}>
            {error}
          </p>
        )}
          <div
            className="list"
            style={{ paddingBottom: "1cqh", maxHeight: "58cqh" }}
          >
            <hr></hr>
            <p className="annotation" style={{ marginLeft: "4cqw" }}>Name:</p>{" "}
            <input
              style={{ width: "78cqw" }}
              type="text"
              placeholder="name"
              value={lobbyName}
              onChange={(e) => setLobbyName(e.target.value)}
            ></input>
            <hr></hr>
            <p className="annotation" style={{ marginLeft: "4cqw" }}>Player count:</p>{" "}
            <input
              style={{ width: "78cqw" }}
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
            <p className="annotation" style={{ marginLeft: "4cqw" }}>Map size:</p>
            <select
              style={{ width: "78cqw" }}
              value={mapSize}
              onChange={(e) =>
                setMapSize(e.target.value as "sm" | "md" | "lg")
              }
            >
              <option value="lg">Large (500 m)</option>
              <option value="md">Medium (300 m, Default)</option>
              <option value="sm">Small (150 m)</option>
            </select>
            <p className="annotation" style={{ marginLeft: "4cqw" }}>Location</p>
            <p role="status" style={{ fontSize: "0.7rem", margin: "0 0 1cqh" }}>{locationStatus}</p>
            <LocationPickerMap value={location} myLocation={myLocation} radius={ZONE_RADIUS_M[mapSize]} onChange={(coords) => {
              pinPlaced.current = true;
              setLocation(coords);
              setLocationStatus("Using your selected location.");
            }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: "10cqw" }}>
          <button
            className="create-button"
            style={{ width: "30cqw" }}
            onClick={() => navigate("/lobbies")}
          >
            Back
          </button>
          <button
            className="create-button"
            style={{ width: "30cqw" }}
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
