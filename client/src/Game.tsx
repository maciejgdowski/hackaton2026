import "./Style.css";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Circle, CircleMarker, useMap } from "react-leaflet";
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
  role: "killer" | "seeker" | null; // only known for yourself (and for everyone once the game ends)
}

interface GameState {
  status: "playing" | "finished";
  serverTime: number;
  startedAt: number;
  endsAt: number;
  zone: { center: { lat: number; lng: number }; radius: number };
  self: {
    id: string;
    name: string;
    role: "killer" | "seeker";
    slot: number;
    alive: boolean;
    killedByName: string | null;
  };
  players: GamePlayer[];
  seekersLeft: number;
  sonar: SonarConfig;
  sonarOn: boolean;
  scanCooldownUntil: number | null;
  // other players' dots: killers get them live, seekers get a new snapshot at every ping
  map: { at: number; nextAt: number; positions: { lat: number; lng: number }[] } | null;
  result: { winner: "killer" | "seeker"; reason: string; endedAt: number } | null;
}

export default function GamePage() {
  const navigate = useNavigate();
  const { gameId } = useParams();
  const userId = localStorage.getItem("userId");
  const [gameData, setGameData] = useState<GameState | null>(null);
  const [error, setError] = useState("");
  const [soundOn, setSoundOn] = useState(isSonarReady());
  const [myPosition, setMyPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const [canReconnect, setCanReconnect] = useState(false);
  const [, setTick] = useState(0);
  const centeredRef = useRef(false);
  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

  // Live game updates from the server (every second and after every change).
  // The same socket sends our GPS position back once a second.
  useEffect(() => {
    if (!gameId || !userId) {
      setError("Join a lobby first.");
      return;
    }
    let disposed = false;
    setError("");
    setCanReconnect(false);

    const socketUrl = new URL(API_URL);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.pathname = `/game/${encodeURIComponent(gameId)}`;
    socketUrl.search = new URLSearchParams({ userId }).toString();
    const socket = new WebSocket(socketUrl);

    let watchId: number | undefined;
    let timerId: number | undefined;
    let latestLocation: { lat: number; lng: number; accuracy: number; timestamp: number } | null = null;

    function startLocationTracking() {
      if (watchId !== undefined) return; // prevents multiple trackers
      if (!navigator.geolocation) {
        setError("This browser does not support location.");
        return;
      }

      watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (disposed) return;
          latestLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
          };
          setMyPosition({ lat: position.coords.latitude, lng: position.coords.longitude });
        },
        (positionError) => {
          if (disposed) return;
          latestLocation = null;
          setError(`Location unavailable: ${positionError.message}`);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 }
      );

      timerId = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN || !latestLocation) return;
        // Skip old readings and avoid queuing updates on a slow connection.
        if (Date.now() - latestLocation.timestamp > 10_000) return;
        if (socket.bufferedAmount > 0) return;
        socket.send(JSON.stringify({ type: "player:location", location: latestLocation }));
      }, 1_000);
    }

    function stopLocationTracking() {
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
      window.clearInterval(timerId);
      watchId = undefined;
      timerId = undefined;
      latestLocation = null;
    }

    socket.onmessage = (event) => {
      if (disposed) return;
      try {
        const message = JSON.parse(event.data) as { type?: string; game?: GameState };
        if (message.type === "game:update" && message.game) {
          setGameData(message.game);
        } else if (message.type === "location:start") {
          startLocationTracking();
        } else if (message.type === "game:closed") {
          navigate(`/lobby/${gameId}`);
        }
      } catch (messageError) {
        console.error("Could not read game update:", messageError);
      }
    };
    socket.onclose = (event) => {
      stopLocationTracking();
      if (disposed) return;
      if (event.code !== 1000) {
        setError(event.reason || "Connection lost. Reconnect to resume.");
        setCanReconnect(event.code !== 1008);
      }
    };

    return () => {
      disposed = true;
      stopLocationTracking();
      socket.close();
    };
  }, [gameId, userId, API_URL, navigate, retry]);

  // Keep the sonar in sync: only make sound / listen while alive, playing and someone is close on GPS
  useEffect(() => {
    if (!gameData) return;
    const active = gameData.status === "playing" && gameData.self.alive && gameData.sonarOn;
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

  // Same button for everyone. Killer: catches a seeker. Seeker: exchanges data with another seeker.
  async function scanPlayer(targetId: string) {
    if (!gameId || !userId) return;
    setIsScanning(true);
    setScanMessage("");
    try {
      const response = await fetch(
        `${API_URL}/game/${encodeURIComponent(gameId)}/scan?userId=${encodeURIComponent(userId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId }),
        }
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Could not scan (${response.status}).`);
      }
      const data = (await response.json()) as { result: string; name: string };
      if (data.result === "caught") setScanMessage(`${data.name} caught`);
      else if (data.result === "transfer") handleDataTransfer(data.name);
      else setScanMessage("No data received");
      navigator.vibrate?.(200);
    } catch (requestError) {
      setScanMessage(requestError instanceof Error ? requestError.message : "Could not scan.");
    } finally {
      setIsScanning(false);
    }
  }

  // Two seekers scanned each other. What they exchange is coming later.
  function handleDataTransfer(name: string) {
    // TODO: data transfer between seekers
    setScanMessage(`Connected with ${name}`);
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
          {canReconnect && <button onClick={() => setRetry((current) => current + 1)}>Reconnect</button>}
          {error && <button onClick={() => navigate("/lobbies")}>Back</button>}
        </div>
      </div>
    );
  }

  const { self, zone } = gameData;
  const isKiller = self.role === "killer";
  // the phone's clock can be off, so count from the server's time
  const clockOffset = gameData.serverTime - Date.now();
  const secondsLeft = Math.max(0, Math.ceil((gameData.endsAt - (Date.now() + clockOffset)) / 1000));
  const timeLeft = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;
  // your role is shown for the first 5 seconds only, so nobody can read it off your screen later
  const showRole = Date.now() + clockOffset - gameData.startedAt < 5000;
  const seekersLeft = gameData.seekersLeft;

  // Dots fade from full to faint until the next ping (the same on every screen, killers too)
  let dotOpacity = 1;
  let pingIn = 0;
  if (gameData.map) {
    const progress = (Date.now() + clockOffset - gameData.map.at) / (gameData.map.nextAt - gameData.map.at);
    dotOpacity = Math.max(0.25, 1 - Math.min(1, progress) * 0.75);
    pingIn = Math.max(0, Math.ceil((gameData.map.nextAt - (Date.now() + clockOffset)) / 1000));
  }

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
        {gameData.map?.positions.map((position, index) => (
          <CircleMarker
            key={index}
            center={[position.lat, position.lng]}
            radius={7}
            pathOptions={{ color: "#ffffff", fillColor: "#34d399", fillOpacity: dotOpacity, opacity: dotOpacity }}
          />
        ))}
        {myPosition && (
          <CircleMarker
            center={[myPosition.lat, myPosition.lng]}
            radius={7}
            pathOptions={{ color: "#09090a", fillColor: "#ffffff", fillOpacity: 1 }}
          />
        )}
        {myPosition && <CenterOnMe position={myPosition} centeredRef={centeredRef} />}
      </GameBackgroundMap>

      <div className="game-hud-overlay">
        {/* Top bar */}
        <div className="game-bar">
          <div className="card" style={{ minHeight: "7vh", width: "90vw", display: "flex", justifyContent: "space-around", alignItems: "center" }}>
            <p>{!self.alive ? "Signal lost" : self.name}</p>
            <p style={{ fontFamily: "var(--tm-font-mono)" }}>{timeLeft}</p>
            <p>Seekers: {seekersLeft}</p>
            {gameData.map && <p style={{ fontFamily: "var(--tm-font-mono)" }}>Ping {pingIn}s</p>}
          </div>
        </div>

        {showRole && gameData.status === "playing" && (
          <div className="game-bar">
            <div className="card" style={{ width: "80vw", display: "flex", flexDirection: "column", alignItems: "center", padding: "3vh 0" }}>
              <p className="annotation" style={{ margin: 0 }}>Your role</p>
              <h1 style={{ margin: 0 }}>{isKiller ? "Killer" : "Seeker"}</h1>
              <p style={{ fontSize: "0.75rem", margin: 0 }}>{isKiller ? "Scan seekers to catch them." : "Hide. Scan other seekers to connect."}</p>
            </div>
          </div>
        )}

        {error && (
          <div className="game-bar">
            <div className="card" style={{ width: "80vw", display: "flex", flexDirection: "column", alignItems: "center" }}>
              <p role="alert" style={{ color: "#ff7070", margin: 0 }}>{error}</p>
              {canReconnect && <button onClick={() => setRetry((current) => current + 1)}>Reconnect</button>}
            </div>
          </div>
        )}

        {/* Bottom controls */}
        <div className="game-bar">
          <div className="card" style={{ minHeight: "12vh", width: "80vw", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "1vh", padding: "1vh 0" }}>
            {gameData.status === "finished" && gameData.result ? (
              <>
                <h3>{gameData.result.winner === "killer" ? "Killers win" : "Seekers win"}</h3>
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
            ) : (
              <ScanButton gameData={gameData} clockOffset={clockOffset} isScanning={isScanning} message={scanMessage} onScan={scanPlayer} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

interface ScanButtonProps {
  gameData: GameState;
  clockOffset: number;
  isScanning: boolean;
  message: string;
  onScan: (targetId: string) => void;
}

// The same for killers and seekers. Fills up while the sonar hears someone within ~2 m
// for HOLD_S seconds, then you can scan them.
function ScanButton({ gameData, clockOffset, isScanning, message, onScan }: ScanButtonProps) {
  const now = Date.now() + clockOffset;
  const cooldownLeft = gameData.scanCooldownUntil ? Math.ceil((gameData.scanCooldownUntil - now) / 1000) : 0;

  // the closest player = the one the sonar has heard the longest
  let target: GamePlayer | null = null;
  let heldS = 0;
  for (const player of gameData.players) {
    if (player.id === gameData.self.id || !player.alive) continue;
    const proximity = getProximity(player.slot);
    if (proximity.near && (target === null || proximity.heldS > heldS)) {
      target = player;
      heldS = proximity.heldS;
    }
  }

  const charged = target !== null && heldS >= HOLD_S && cooldownLeft <= 0;
  const percent = cooldownLeft > 0 || target === null ? 0 : Math.min(100, (heldS / HOLD_S) * 100);

  let status = "";
  if (cooldownLeft > 0) status = `Recharging ${cooldownLeft}s`;
  else if (charged && target) status = `${target.name} in range`;
  else if (target) status = "Stay close...";
  else if (gameData.sonarOn) status = "Nobody within 2 m";
  else status = "Nobody close";

  return (
    <>
      <button
        data-variant={charged ? "primary" : undefined}
        disabled={!charged || isScanning}
        onClick={() => {
          if (target) onScan(target.id);
        }}
        style={{
          width: "60vw",
          height: "6vh",
          background: charged ? undefined : `linear-gradient(to right, var(--tm-bg-active) ${percent}%, transparent ${percent}%)`,
        }}
      >
        {isScanning ? "Scanning..." : "Scan"}
      </button>
      <p style={{ fontSize: "0.75rem", fontFamily: "var(--tm-font-mono)", margin: 0 }}>{status}</p>
      {message && <p style={{ fontSize: "0.75rem", margin: 0 }}>{message}</p>}
    </>
  );
}

interface CenterOnMeProps {
  position: { lat: number; lng: number };
  centeredRef: { current: boolean };
}

// Center the map on this phone once, then leave the player free to pan.
function CenterOnMe({ position, centeredRef }: CenterOnMeProps) {
  const map = useMap();
  useEffect(() => {
    if (centeredRef.current) return;
    centeredRef.current = true;
    map.panTo([position.lat, position.lng]);
  }, [map, position, centeredRef]);
  return null;
}
