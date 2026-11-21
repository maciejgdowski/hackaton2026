import "./Style.css";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Circle, CircleMarker } from "react-leaflet";
import GameBackgroundMap from "./GameBackgroundMap";
import {
  configureSonar,
  getProximity,
  HOLD_S,
  isSonarReady,
  setEmitting,
  setListening,
  startSonar,
  type SonarConfig,
} from "./Sonar";

interface GamePlayer {
  id: string;
  name: string;
  slot: number;
  alive: boolean;
  role: "hunter" | "runner" | null; // only known for yourself (and for everyone once the game ends)
}

interface GameState {
  phase: "playing" | "ended";
  serverTime: number;
  endsAt: number;
  zone: { center: { lat: number; lng: number }; radius: number };
  self: {
    id: string;
    name: string;
    role: "hunter" | "runner";
    slot: number;
    alive: boolean;
    killedByName: string | null;
  };
  players: GamePlayer[];
  sonar: SonarConfig;
  sonarOn: boolean;
  killCooldownUntil: number | null;
  clue: { at: number; nextAt: number; positions: { id: string; lat: number; lng: number }[] } | null;
  result: { winner: "hunter" | "runner"; reason: string; endedAt: number } | null;
}

export default function GamePage() {
  const navigate = useNavigate();
  const { gameId } = useParams();
  const userId = localStorage.getItem("userId");
  const [gameData, setGameData] = useState<GameState | null>(null);
  const [error, setError] = useState("");
  const [soundOn, setSoundOn] = useState(isSonarReady());
  const [myPosition, setMyPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [isKilling, setIsKilling] = useState(false);
  const [, setTick] = useState(0);
  const lastSentAt = useRef(0);
  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

  // Live game updates from the server (every second and after every change)
  useEffect(() => {
    if (!gameId || !userId) {
      setError("Join a lobby first.");
      return;
    }

    const socketUrl = new URL(API_URL);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.pathname = `/game/${encodeURIComponent(gameId)}`;
    socketUrl.search = new URLSearchParams({ userId }).toString();
    const socket = new WebSocket(socketUrl);

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type?: string; game?: GameState };
        if (message.type === "game:update" && message.game) {
          setGameData(message.game);
        } else if (message.type === "game:closed") {
          navigate(`/lobby/${gameId}`);
        }
      } catch (messageError) {
        console.error("Could not read game update:", messageError);
      }
    };
    socket.onclose = (event) => {
      if (event.code !== 1000) setError("Lost connection to the game. Reload the page.");
    };
    return () => socket.close();
  }, [gameId, userId, API_URL, navigate]);

  // Keep the sonar in sync: only make sound / listen while alive, playing and someone is close on GPS
  useEffect(() => {
    if (!gameData) return;
    const active = gameData.phase === "playing" && gameData.self.alive && gameData.sonarOn;
    configureSonar(gameData.sonar, gameData.self.slot);
    setEmitting(active);
    setListening(active);
  }, [gameData]);

  // Turn the sonar off when leaving the page
  useEffect(() => {
    return () => {
      setEmitting(false);
      setListening(false);
    };
  }, []);

  // Send our GPS position to the server (at most every 3 seconds)
  useEffect(() => {
    if (!gameId || !userId || !navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        setMyPosition({ lat: latitude, lng: longitude });

        const now = Date.now();
        if (now - lastSentAt.current < 3000) return;
        lastSentAt.current = now;

        fetch(`${API_URL}/game/${encodeURIComponent(gameId)}/location?userId=${encodeURIComponent(userId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat: latitude, lng: longitude, accuracy }),
        }).catch((requestError) => console.error("Could not send location:", requestError));
      },
      (positionError) => setError(`GPS: ${positionError.message}`),
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [gameId, userId, API_URL]);

  // Redraw 4 times a second (sonar charge and countdown change all the time)
  useEffect(() => {
    const interval = setInterval(() => setTick((current) => current + 1), 250);
    return () => clearInterval(interval);
  }, []);

  async function enableSound() {
    try {
      await startSonar();
      setSoundOn(true);
      setError("");
    } catch (soundError) {
      setError(soundError instanceof Error ? soundError.message : "Could not start the sound.");
    }
  }

  async function killPlayer(targetId: string) {
    if (!gameId || !userId) return;
    setIsKilling(true);
    try {
      const response = await fetch(
        `${API_URL}/game/${encodeURIComponent(gameId)}/kill?userId=${encodeURIComponent(userId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId }),
        }
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Could not kill (${response.status}).`);
      }
      navigator.vibrate?.(200);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not kill.");
    } finally {
      setIsKilling(false);
    }
  }

  async function backToLobby() {
    if (!gameId || !userId) return;
    // the admin reopens the lobby for everyone; for the others this just fails quietly
    await fetch(`${API_URL}/lobby/${encodeURIComponent(gameId)}/reset?userId=${encodeURIComponent(userId)}`, {
      method: "POST",
    }).catch(() => {});
    navigate(`/lobby/${gameId}`);
  }

  if (!gameData) {
    return (
      <div className="main" style={{ justifyContent: "center", height: "80vh" }}>
        <div className="card" style={{ width: "70vw" }}>
          <p>{error || "Loading game..."}</p>
          {error && <button onClick={() => navigate("/")}>Back</button>}
        </div>
      </div>
    );
  }

  const { self, zone } = gameData;
  const isHunter = self.role === "hunter";
  // the phone's clock can be off, so count from the server's time
  const clockOffset = gameData.serverTime - Date.now();
  const secondsLeft = Math.max(0, Math.ceil((gameData.endsAt - (Date.now() + clockOffset)) / 1000));
  const timeLeft = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
  const runnersLeft = gameData.players.filter((player) => player.role !== "hunter" && player.alive && player.id !== self.id).length
    + (!isHunter && self.alive ? 1 : 0);

  // keep the map around the zone
  const latPad = (zone.radius * 2) / 111320;
  const lngPad = (zone.radius * 2) / (111320 * Math.cos((zone.center.lat * Math.PI) / 180));

  return (
    <>
      <GameBackgroundMap
        center={[zone.center.lat, zone.center.lng]}
        zoom={16}
        minZoom={13}
        maxZoom={19}
        maxBounds={[
          [zone.center.lat - latPad, zone.center.lng - lngPad],
          [zone.center.lat + latPad, zone.center.lng + lngPad],
        ]}
      >
        <Circle
          center={[zone.center.lat, zone.center.lng]}
          radius={zone.radius}
          pathOptions={{ color: "#f2f2f0", weight: 1, fillOpacity: 0.05 }}
        />
        {gameData.clue?.positions.map((position) => (
          <CircleMarker
            key={position.id}
            center={[position.lat, position.lng]}
            radius={8}
            pathOptions={{ color: "#b5b5b1", fillColor: "#b5b5b1", fillOpacity: 0.4 }}
          />
        ))}
        {myPosition && self.alive && (
          <CircleMarker
            center={[myPosition.lat, myPosition.lng]}
            radius={7}
            pathOptions={{ color: "#09090a", fillColor: "#ffffff", fillOpacity: 1 }}
          />
        )}
      </GameBackgroundMap>

      <div className="game-hud-overlay">
        {/* Top bar */}
        <div className="game-bar">
          <div className="card" style={{ minHeight: "7vh", width: "90vw", display: "flex", justifyContent: "space-around", alignItems: "center" }}>
            <p>{!self.alive ? "Signal lost" : isHunter ? "Hunter" : "Runner"}</p>
            <p style={{ fontFamily: "var(--tm-font-mono)" }}>{timeLeft}</p>
            <p>Runners: {runnersLeft}</p>
            {isHunter && gameData.clue && (
              <p>Clue in {Math.max(0, Math.ceil((gameData.clue.nextAt - (Date.now() + clockOffset)) / 1000))}s</p>
            )}
          </div>
        </div>

        {error && (
          <div className="game-bar">
            <p role="alert" className="card" style={{ color: "#ff7070", margin: 0, width: "80vw" }}>{error}</p>
          </div>
        )}

        {/* Bottom controls */}
        <div className="game-bar">
          <div className="card" style={{ minHeight: "12vh", width: "80vw", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "1vh", padding: "1vh 0" }}>
            {gameData.phase === "ended" && gameData.result ? (
              <>
                <h3>{gameData.result.winner === "hunter" ? "Hunters win" : "Runners win"}</h3>
                <p>{gameData.result.reason}</p>
                {self.killedByName && <p style={{ fontSize: "0.75rem" }}>You were caught by {self.killedByName}</p>}
                <button onClick={backToLobby}>Back to lobby</button>
              </>
            ) : !self.alive ? (
              <>
                <h3>Signal lost</h3>
                <p>You are out. Wait for the round to end.</p>
              </>
            ) : !soundOn ? (
              <>
                <p>The sonar needs sound and the microphone.</p>
                <button data-variant="primary" onClick={enableSound}>Enable sound</button>
              </>
            ) : isHunter ? (
              <KillButtons gameData={gameData} clockOffset={clockOffset} isKilling={isKilling} onKill={killPlayer} />
            ) : (
              <>
                <h3>Hide</h3>
                <p style={{ fontSize: "0.75rem", fontFamily: "var(--tm-font-mono)" }}>Sonar {gameData.sonarOn ? "on – someone is close" : "off – nobody close"}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

interface KillButtonsProps {
  gameData: GameState;
  clockOffset: number;
  isKilling: boolean;
  onKill: (targetId: string) => void;
}

// One button per runner the sonar hears within ~2 m. It fills up for HOLD_S seconds, then you can kill.
function KillButtons({ gameData, clockOffset, isKilling, onKill }: KillButtonsProps) {
  const now = Date.now() + clockOffset;
  const cooldownLeft = gameData.killCooldownUntil ? Math.ceil((gameData.killCooldownUntil - now) / 1000) : 0;

  if (cooldownLeft > 0) {
    return <button disabled>Recharging {cooldownLeft}s</button>;
  }

  const targets = gameData.players
    .filter((player) => player.id !== gameData.self.id && player.alive && player.role !== "hunter")
    .map((player) => ({ player, proximity: getProximity(player.slot) }))
    .filter((target) => target.proximity.near);

  if (targets.length === 0) {
    return <button disabled>{gameData.sonarOn ? "No runner within 2 m" : "Nobody close"}</button>;
  }

  return (
    <>
      {targets.map(({ player, proximity }) => {
        const charged = proximity.heldS >= HOLD_S;
        const percent = Math.min(100, (proximity.heldS / HOLD_S) * 100);
        return (
          <button
            key={player.id}
            data-variant={charged ? "primary" : undefined}
            disabled={!charged || isKilling}
            onClick={() => onKill(player.id)}
            style={{
              width: "60vw",
              background: charged ? undefined : `linear-gradient(to right, var(--tm-bg-active) ${percent}%, transparent ${percent}%)`,
            }}
          >
            {charged ? `Kill ${player.name}` : `${player.name} · stay close`}
          </button>
        );
      })}
    </>
  );
}
