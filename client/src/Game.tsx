import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { CircleMarker, Tooltip } from "react-leaflet";
import GameBackgroundMap from "./GameBackgroundMap";

interface PlayerLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}

export default function GamePage() {
  const { gameId } = useParams();
  const [players, setPlayers] = useState<PlayerLocation[]>([]);
  const [role, setRole] = useState<"crewmate" | "impostor" | null>(null);
  const [center, setCenter] = useState<[number, number] | null>(null);
  const centeredGameRef = useRef<string | null>(null);
  const [status, setStatus] = useState("Connecting...");
  const [retry, setRetry] = useState(0);
  const [canReconnect, setCanReconnect] = useState(false);

  useEffect(() => {
    const userId = localStorage.getItem("userId");
    if (!gameId || !userId) { setStatus("Join a lobby before opening the game."); return; }
    let disposed = false;
    setStatus("Connecting...");
    setCanReconnect(false);

    const url = new URL(
      import.meta.env.VITE_API_URL ?? "http://localhost:4000",
    );

    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/game/${encodeURIComponent(gameId)}`;
    url.search = new URLSearchParams({ userId }).toString();

    const socket = new WebSocket(url);

    let watchId: number | undefined;
    let timerId: number | undefined;

    let latestLocation: {
      lat: number;
      lng: number;
      accuracy: number;
      timestamp: number;
    } | null = null;

    function startLocationTracking() {
      if (watchId !== undefined) return;//prevents multiple trackers

      if (!navigator.geolocation) {
        setStatus("This browser does not support location.");
        return;
      }

      setStatus("Allow location access to appear on the map.");
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (disposed) return;
          latestLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
          };

          // Center once on this device, then leave the player free to pan.
          if (gameId && centeredGameRef.current !== gameId) {
            centeredGameRef.current = gameId;
            setCenter([position.coords.latitude, position.coords.longitude]);
          }

          setStatus("Sharing your location");
        },
        (error) => {
          if (disposed) return;
          latestLocation = null;
          setStatus(`Location unavailable: ${error.message}`);
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10_000,
        },
      );

      timerId = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!latestLocation) return;

        // Skip old readings and avoid queuing updates on a slow connection.
        if (Date.now() - latestLocation.timestamp > 10_000) {
          setStatus("Waiting for a fresh GPS reading..."); return;
        }
        if (socket.bufferedAmount > 0) return;

        socket.send(JSON.stringify({
          type: "player:location",
          location: latestLocation,
        }));
      }, 1_000);
    }

    function stopLocationTracking() {
      if (watchId !== undefined) {
        navigator.geolocation.clearWatch(watchId);
      }

      window.clearInterval(timerId);
      watchId = undefined;
      timerId = undefined;
      latestLocation = null;
    }



    socket.onopen = () => {
      console.log("Connected to game:", gameId);
    };

    socket.onmessage = (event) => {
      if (disposed) return;
      try {
        const message = JSON.parse(event.data);

        if (message.type === "game:state") {
          setRole(message.role);
          if (centeredGameRef.current !== gameId) {
            setCenter([message.center.lat, message.center.lng]);
          }
        } else if (message.type === "location:start") {
          console.log("Backend requested location tracking.");
          startLocationTracking();
        } else if (message.type === "game:locations") {
          setPlayers(message.players);
        }
      } catch (error) {
        console.error("Could not read game message:", error);
      }
    };

    socket.onclose = (event) => {
      stopLocationTracking();
      if (disposed) return;
      setPlayers([]);
      setStatus(event.reason || "Connection lost. Reconnect to resume.");
      setCanReconnect(event.code !== 1000 && event.code !== 1008);
    };

    return () => {
      disposed = true;
      stopLocationTracking();
      socket.close();
    };
  }, [gameId, retry]);

  return (
    <>
      {center && <GameBackgroundMap key={`${gameId}:${center.join(",")}`} center={center}>
          {players.map((player) => (
            <CircleMarker
              key={player.id}
              center={[player.lat, player.lng]}
              radius={7}
              pathOptions={{
                color: "#ffffff",
                fillColor: "#34d399",
                fillOpacity: 1,
              }}
            >
            <Tooltip>{player.name}{player.id === localStorage.getItem("userId") ? " (you)" : ""}</Tooltip>
          </CircleMarker>
        ))}
      </GameBackgroundMap>}

      <div className="game-hud-overlay">
        {/* Top bar */}
        <div className="game-bar">
          <div className="card" style={{ minHeight:"7vh", width:"90vw", display:"flex", flexDirection:"column", alignItems:"center"}}>
            <strong style={{ color: role === "impostor" ? "#ff7070" : "#34d399" }}>
              {role ? `Your role: ${role === "impostor" ? "Impostor" : "Crewmate"}` : "Loading role..."}
            </strong>
            <p role="status">{status} · Players on map: {players.length}</p>
            {canReconnect && <button onClick={() => setRetry(value => value + 1)}>Reconnect</button>}
          </div>
        </div>

        {/* Bottom controls */}
        <div className="game-bar">
          <div className="card" style={{ height:"12vh", width:"70vw", display:"flex", justifyContent:"center", alignItems:"center"}}><h3>Action</h3 ></div>
        </div>
      </div>
    </>
  );
}
