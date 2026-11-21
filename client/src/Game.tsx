import "./Style.css";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import L from "leaflet";
import { Circle, CircleMarker, Marker, useMap } from "react-leaflet";
import GameBackgroundMap from "./GameBackgroundMap";
import TaskMarkers, { type TaskPoint, type Tower } from "./TaskMarkers";
import VotePanel from "./VotePanel";
import CluesPanel from "./CluesPanel";
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
  votedOut: boolean;
  role: "killer" | "seeker" | null; // only known for yourself, voted-out players and everyone once the game ends
}

interface GameState {
  status: "playing" | "finished";
  serverTime: number;
  startedAt: number;
  zone: { center: { lat: number; lng: number }; radius: number };
  self: {
    id: string;
    name: string;
    role: "killer" | "seeker";
    slot: number;
    alive: boolean;
    killedByName: string | null;
    leftZone: boolean; // eliminated for going too far outside the play area
    votedOut: boolean;
    zone: "inside" | "outside" | "leaving"; // "leaving" = too far out, eliminatedAt is counting down
    eliminatedAt: number | null;
    download: { pointId: string; progress: number; here: boolean } | null;
    upload: { progress: number; here: boolean } | null; // uploading the data I carry at its tower
    carrying: string | null; // point whose data I carry
    clues: string[]; // players I know are not the killer
    notice: { text: string; at: number } | null;
    killCooldownUntil: number | null; // killer only
    shareCooldownUntil: number | null;
    voteCooldownUntil: number;
    touching: string[]; // players whose phones touch mine (directly or through others)
  };
  players: GamePlayer[];
  seekersLeft: number;
  votesNeeded: number;
  towers: Tower[];
  points: TaskPoint[];
  sonar: SonarConfig;
  sonarOn: boolean;
  // other players' dots: the killer gets them live (carrying = has data), seekers get a new snapshot at every ping
  // live = my sonar hears this phone right now, so it's shown where it really is (not faded)
  map: { at: number; nextAt: number; positions: { lat: number; lng: number; carrying: boolean; live: boolean }[] } | null;
  vote: { endsAt: number; needed: number; participants: string[]; voted: number; myVote: string | null } | null;
  voteRunning: boolean;
  lastVote: { at: number; targetName: string | null; role: "killer" | "seeker" | null; votes: number; needed: number } | null;
  downloadMs: number;
  membersLeft: number; // players still in the lobby (1 = only me, everyone else quit)
  result: { winner: "killer" | "seeker"; reason: string; endedAt: number } | null;
}

const SITE_RANGE_M = 15; // same as the server: how close you have to stand at a point or tower

// 125 -> "2:05" (cooldowns are shown in minutes)
function minutes(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// My own dot: a white dot with a light beam showing which way the phone is facing (like a compass).
function headingIcon(heading: number) {
  return L.divIcon({
    className: "task-icon",
    html: `<div class="heading-marker" style="transform: rotate(${heading}deg)">
      <svg viewBox="0 0 60 60" width="60" height="60">
        <defs><linearGradient id="beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>
        <path d="M30 30 L16 4 A30 30 0 0 1 44 4 Z" fill="url(#beam)"/>
        <circle cx="30" cy="30" r="7" fill="#ffffff" stroke="#09090a" stroke-width="2.5"/>
      </svg>
    </div>`,
    iconSize: [60, 60],
    iconAnchor: [30, 30],
  });
}

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export default function GamePage() {
  const navigate = useNavigate();
  const { gameId } = useParams();
  const userId = localStorage.getItem("userId");
  const [gameData, setGameData] = useState<GameState | null>(null);
  const [error, setError] = useState("");
  const [soundOn, setSoundOn] = useState(isSonarReady());
  const [myPosition, setMyPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [heading, setHeading] = useState<number | null>(null); // which way the phone faces (0 = north), null = no compass
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showClues, setShowClues] = useState(false);
  const [retry, setRetry] = useState(0);
  const [canReconnect, setCanReconnect] = useState(false);
  const [, setTick] = useState(0);
  const centeredRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const gameDataRef = useRef<GameState | null>(null); // latest gameData for timers that keep running
  const quittingRef = useRef(false);
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
    socketRef.current = socket;

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
        const data = JSON.parse(event.data) as { type?: string; game?: GameState };
        if (data.type === "game:update" && data.game) {
          setGameData(data.game);
        } else if (data.type === "location:start") {
          startLocationTracking();
        } else if (data.type === "game:closed") {
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
      socketRef.current = null;
    };
  }, [gameId, userId, API_URL, navigate, retry]);

  // Keep the sonar in sync: only make sound / listen while alive, playing and someone is close on GPS
  useEffect(() => {
    gameDataRef.current = gameData;
    if (!gameData) return;
    const active = gameData.status === "playing" && gameData.self.alive && gameData.sonarOn;
    configureSonar(gameData.sonar, gameData.self.slot);
    setEmitting(active);
    setListening(active);
  }, [gameData]);

  // Everyone else quit: nothing left to play, back to the main menu
  useEffect(() => {
    if (gameData && gameData.membersLeft <= 1) quitMatch(false);
  });

  // Turn the sonar off when leaving the page
  useEffect(() => {
    return () => {
      setEmitting(false);
      setListening(false);
    };
  }, []);

  // Compass: which way the phone is facing. iPhone gives webkitCompassHeading,
  // Android gives an "absolute" alpha (counter-clockwise from north). Rounded so the map doesn't redraw for tiny wobbles.
  useEffect(() => {
    function onOrientation(event: DeviceOrientationEvent) {
      const iphoneHeading = (event as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      let degrees: number | null = null;
      if (typeof iphoneHeading === "number") degrees = iphoneHeading;
      else if (event.absolute && event.alpha !== null) degrees = 360 - event.alpha;
      if (degrees === null) return;
      const rounded = Math.round(degrees / 5) * 5 % 360;
      setHeading((current) => (current === rounded ? current : rounded));
    }
    window.addEventListener("deviceorientationabsolute", onOrientation as EventListener);
    window.addEventListener("deviceorientation", onOrientation);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onOrientation as EventListener);
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, []);

  // Redraw 4 times a second (sonar charge and countdowns change all the time)
  useEffect(() => {
    const interval = setInterval(() => setTick((current) => current + 1), 250);
    return () => clearInterval(interval);
  }, []);

  // Tell the server whose phones we touch (the sonar hears them within ~2 m), once a second.
  // That's what lets touching players call a vote together.
  useEffect(() => {
    const interval = setInterval(() => {
      const socket = socketRef.current;
      const gameData = gameDataRef.current;
      if (!gameData || !socket || socket.readyState !== WebSocket.OPEN) return;
      const slots: number[] = [];
      for (const player of gameData.players) {
        if (player.id === gameData.self.id || !player.alive) continue;
        if (getProximity(player.slot).near) slots.push(player.slot);
      }
      if (slots.length > 0) socket.send(JSON.stringify({ type: "player:nearby", slots }));
    }, 1000);
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

  // Every game action is a POST to /game/:gameId/<path>. Errors are shown under the buttons.
  async function sendAction(path: string, body: object) {
    if (!gameId || !userId) return null;
    setIsBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `${API_URL}/game/${encodeURIComponent(gameId)}/${path}?userId=${encodeURIComponent(userId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = (await response.json().catch(() => ({}))) as { error?: string; result?: string; name?: string; gained?: number };
      if (!response.ok) throw new Error(data.error ?? `Something went wrong (${response.status}).`);
      return data;
    } catch (requestError) {
      setMessage(requestError instanceof Error ? requestError.message : "Something went wrong.");
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  // Leave the match (counts as being out) and go to the main menu.
  async function quitMatch(ask: boolean) {
    if (!gameId || !userId || quittingRef.current) return;
    if (ask && !window.confirm("Quit the match? You will be out of the game.")) return;
    quittingRef.current = true;
    await fetch(`${API_URL}/lobby/${encodeURIComponent(gameId)}/leave?userId=${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }).catch(() => {});
    navigate("/lobbies");
  }

  // Touching phones: Share copies clues both ways. Kill is the killer's own button.
  async function sharePlayer(targetId: string, action: "share" | "kill") {
    const data = await sendAction("scan", { targetId, action });
    if (!data) return;
    navigator.vibrate?.(200);
    if (data.result === "caught") setMessage(`${data.name} is out`);
    else setMessage(`Shared clues with ${data.name}${data.gained ? ` (+${data.gained})` : ""}`);
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
      <div className="main" style={{ justifyContent: "center", height: "80cqh" }}>
        <div className="card" style={{ width: "70cqw" }}>
          <p>{error || "Loading game..."}</p>
          {canReconnect && <button onClick={() => setRetry((current) => current + 1)}>Reconnect</button>}
          {error && <button onClick={() => navigate("/lobbies")}>Back</button>}
        </div>
      </div>
    );
  }

  const { self, zone } = gameData;
  const isKiller = self.role === "killer";
  const playing = gameData.status === "playing";
  // the phone's clock can be off, so count from the server's time
  const clockOffset = gameData.serverTime - Date.now();
  const now = Date.now() + clockOffset;
  // no time limit: show how long the game has been going
  const secondsPlayed = Math.max(0, Math.floor((now - gameData.startedAt) / 1000));
  const timePlayed = `${Math.floor(secondsPlayed / 60)}:${String(secondsPlayed % 60).padStart(2, "0")}`;
  // your role is shown for the first 5 seconds only, so nobody can read it off your screen later
  const showRole = now - gameData.startedAt < 5000;
  const showNotice = self.notice && now - self.notice.at < 6000;
  const showVoteResult = gameData.lastVote && now - gameData.lastVote.at < 10_000;

  // Dots fade from full to faint until the next ping (the same on every screen, the killer's too)
  let dotOpacity = 1;
  let pingIn = 0;
  if (gameData.map) {
    const progress = (now - gameData.map.at) / (gameData.map.nextAt - gameData.map.at);
    dotOpacity = Math.max(0.25, 1 - Math.min(1, progress) * 0.75);
    pingIn = Math.max(0, Math.ceil((gameData.map.nextAt - now) / 1000));
  }

  // open zoomed so the whole play area fits on a phone screen
  let zoom = 14;
  if (zone.radius <= 150) zoom = 16;
  else if (zone.radius <= 300) zoom = 15;

  // keep the map around the zone
  const latPad = (zone.radius * 2) / 111320;
  const lngPad = (zone.radius * 2) / (111320 * Math.cos((zone.center.lat * Math.PI) / 180));

  // the closest download point (so we can offer the Download button when standing at one)
  let nearestPoint: TaskPoint | null = null;
  let nearestMeters = Infinity;
  if (myPosition) {
    for (const point of gameData.points) {
      const meters = metersBetween(myPosition, point);
      if (meters < nearestMeters) {
        nearestPoint = point;
        nearestMeters = meters;
      }
    }
  }
  const carriedPoint = gameData.points.find((point) => point.id === self.carrying);
  const targetTower = carriedPoint ? gameData.towers.find((tower) => tower.id === carriedPoint.towerId) : undefined;
  const towerMeters = targetTower && myPosition ? Math.round(metersBetween(myPosition, targetTower)) : null;

  // Vote button: how many of us touch phones right now, and how many are needed
  const groupSize = self.touching.length + 1;
  const voteCooldown = Math.max(0, Math.ceil((self.voteCooldownUntil - now) / 1000));
  // the killer has one extra button (Kill), so the bottom buttons get a bit narrower
  const buttonWidth = isKiller ? "20cqw" : "27cqw";
  const canCallVote = playing && self.alive && !gameData.voteRunning && voteCooldown === 0 && groupSize >= gameData.votesNeeded;

  return (
    <>
      <GameBackgroundMap
        center={[zone.center.lat, zone.center.lng]}
        zoom={zoom}
        minZoom={12}
        maxZoom={19}
        maxBounds={[
          [zone.center.lat - latPad, zone.center.lng - lngPad],
          [zone.center.lat + latPad, zone.center.lng + lngPad],
        ]}
      >
        <Circle
          center={[zone.center.lat, zone.center.lng]}
          radius={zone.radius}
          pathOptions={{ color: "#f2f2f0", weight: 2, fillOpacity: 0.05 }}
        />
        <TaskMarkers
          towers={gameData.towers}
          points={gameData.points}
          carrying={self.carrying}
          downloading={self.download?.pointId ?? null}
          rangeM={SITE_RANGE_M}
        />
        {gameData.map?.positions.map((position, index) => (
          <CircleMarker
            key={index}
            center={[position.lat, position.lng]}
            radius={7}
            pathOptions={{
              color: "#ffffff",
              weight: position.live ? 3 : 1,
              fillColor: "#34d399",
              fillOpacity: position.live ? 1 : dotOpacity,
              opacity: position.live ? 1 : dotOpacity,
            }}
          />
        ))}
        {/* killer only: a ring around players carrying data */}
        {gameData.map?.positions.filter((position) => position.carrying).map((position, index) => (
          <CircleMarker
            key={`carrying-${index}`}
            center={[position.lat, position.lng]}
            radius={13}
            pathOptions={{ color: "#ffffff", weight: 2, dashArray: "3 3", fill: false }}
          />
        ))}
        {myPosition && heading === null && (
          <CircleMarker
            center={[myPosition.lat, myPosition.lng]}
            radius={7}
            pathOptions={{ color: "#09090a", fillColor: "#ffffff", fillOpacity: 1 }}
          />
        )}
        {myPosition && heading !== null && (
          <Marker position={[myPosition.lat, myPosition.lng]} icon={headingIcon(heading)} zIndexOffset={1000} interactive={false} />
        )}
        {myPosition && <CenterOnMe position={myPosition} centeredRef={centeredRef} />}
      </GameBackgroundMap>

      <div className="game-hud-overlay">
        <div style={{ display: "flex", flexDirection: "column", gap: "1cqh" }}>
          {/* Top bar */}
          <div className="game-bar">
            <div className="card" style={{ minHeight: "7cqh", width: "90cqw", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "2cqw", padding: "0 3cqw", fontSize: "0.8rem", whiteSpace: "nowrap" }}>
              <p style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{!self.alive ? "Signal lost" : self.name}</p>
              <p style={{ margin: 0, fontFamily: "var(--tm-font-mono)" }}>{timePlayed}</p>
              <p style={{ margin: 0 }}>Seekers {gameData.seekersLeft}</p>
              {gameData.map && <p style={{ margin: 0, fontFamily: "var(--tm-font-mono)" }}>Ping {pingIn}s</p>}
              <button onClick={() => quitMatch(true)} style={{ padding: "0.3rem 0.6rem" }}>Quit</button>
            </div>
          </div>

          {showRole && playing && (
            <div className="game-bar">
              <div className="card" style={{ width: "84cqw", display: "flex", flexDirection: "column", alignItems: "center", padding: "2cqh 4cqw" }}>
                <p className="annotation" style={{ margin: 0 }}>Your role</p>
                <h1 style={{ margin: 0 }}>{isKiller ? "Killer" : "Seeker"}</h1>
                <p style={{ fontSize: "0.75rem", margin: 0 }}>
                  {isKiller
                    ? "Get within 2 m of a seeker and press KILL. You see everyone live, rings mark players carrying data. You can do tasks too, to blend in."
                    : "Download data at points, bring it to its tower. Towers tell you who is not the killer. Touch phones to share clues and vote the killer out."}
                </p>
              </div>
            </div>
          )}

          {showNotice && self.notice && (
            <div className="game-bar">
              <p className="card" style={{ margin: 0, width: "84cqw", padding: "1cqh 2cqw" }}>{self.notice.text}</p>
            </div>
          )}

          {showVoteResult && gameData.lastVote && (
            <div className="game-bar">
              <p className="card" style={{ margin: 0, width: "84cqw", padding: "1cqh 2cqw" }}>
                {gameData.lastVote.targetName
                  ? `${gameData.lastVote.targetName} was voted out · ${gameData.lastVote.role === "killer" ? "Killer" : "Seeker"}`
                  : `Vote failed · nobody out (${gameData.lastVote.votes}/${gameData.lastVote.needed} votes)`}
              </p>
            </div>
          )}

          {self.alive && self.zone === "outside" && playing && (
            <div className="game-bar">
              <p className="card" style={{ margin: 0, width: "84cqw", fontSize: "0.75rem" }}>Outside the zone. Don't go much further.</p>
            </div>
          )}

          {self.alive && self.zone === "leaving" && self.eliminatedAt && playing && (
            <div className="game-bar">
              <p role="alert" className="card" style={{ color: "#ff7070", margin: 0, width: "84cqw" }}>
                Too far out! Go back or you're out in {Math.max(0, Math.ceil((self.eliminatedAt - now) / 1000))}s
              </p>
            </div>
          )}

          {error && (
            <div className="game-bar">
              <div className="card" style={{ width: "84cqw", display: "flex", flexDirection: "column", alignItems: "center" }}>
                <p role="alert" style={{ color: "#ff7070", margin: 0 }}>{error}</p>
                {canReconnect && <button onClick={() => setRetry((current) => current + 1)}>Reconnect</button>}
              </div>
            </div>
          )}
        </div>

        {/* Bottom controls */}
        <div className="game-bar">
          <div className="card" style={{ width: "92cqw", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: "1cqh", padding: "1.5cqh 0" }}>
            {gameData.status === "finished" && gameData.result ? (
              <>
                <h3 style={{ margin: 0 }}>{gameData.result.winner === "killer" ? "The killer wins" : "Seekers win"}</h3>
                <p style={{ margin: 0 }}>{gameData.result.reason}</p>
                <p style={{ fontSize: "0.75rem", margin: 0 }}>
                  Killer: {gameData.players.find((player) => player.role === "killer")?.name ?? "?"}
                </p>
                {self.killedByName && <p style={{ fontSize: "0.75rem", margin: 0 }}>You were caught by {self.killedByName}</p>}
                <div style={{ display: "flex", gap: "3cqw" }}>
                  <button onClick={backToLobby}>Back to lobby</button>
                  <button onClick={() => quitMatch(false)}>Main menu</button>
                </div>
              </>
            ) : !self.alive ? (
              <>
                <h3 style={{ margin: 0 }}>Signal lost</h3>
                <p style={{ margin: 0 }}>
                  {self.votedOut ? "You were voted out." : self.leftZone ? "You went too far outside the zone." : "You are out."} You can still watch the map.
                </p>
                <div style={{ display: "flex", gap: "3cqw" }}>
                  <button onClick={() => setShowClues(true)}>Clues {self.clues.length}</button>
                  <button onClick={() => quitMatch(true)}>Quit</button>
                </div>
              </>
            ) : !soundOn ? (
              <>
                <p style={{ margin: 0 }}>The sonar needs sound and the microphone.</p>
                <button data-variant="primary" onClick={enableSound}>Enable sound</button>
              </>
            ) : (
              <>
                <TaskLine
                  download={self.download}
                  carriedPoint={carriedPoint ?? null}
                  towerMeters={towerMeters}
                  upload={self.upload}
                  onUpload={() => sendAction("upload", {})}
                  nearestPoint={nearestPoint}
                  nearestMeters={nearestMeters}
                  isBusy={isBusy}
                  onDownload={(pointId) => sendAction("download", { pointId })}
                  onDrop={() => sendAction("drop", {})}
                />

                <div style={{ display: "flex", gap: "2cqw" }}>
                  <TouchButtons
                    gameData={gameData}
                    now={now}
                    isKiller={isKiller}
                    isBusy={isBusy}
                    onShare={(targetId) => sharePlayer(targetId, "share")}
                    onKill={(targetId) => sharePlayer(targetId, "kill")}
                  />
                  <button
                    style={{ width: buttonWidth, height: "6cqh", padding: 0 }}
                    disabled={!canCallVote || isBusy}
                    onClick={() => sendAction("vote/start", {})}
                  >
                    {voteCooldown > 0 ? `Vote ${minutes(voteCooldown)}` : `Vote ${groupSize}/${gameData.votesNeeded}`}
                  </button>
                  <button style={{ width: buttonWidth, height: "6cqh", padding: 0 }} onClick={() => setShowClues(true)}>
                    Clues {self.clues.length}
                  </button>
                </div>

                {message && <p style={{ fontSize: "0.75rem", margin: 0 }}>{message}</p>}
              </>
            )}
          </div>
        </div>
      </div>

      {gameData.vote && playing && self.alive && (
        <VotePanel
          players={gameData.players}
          myId={self.id}
          clues={self.clues}
          secondsLeft={Math.max(0, Math.ceil((gameData.vote.endsAt - now) / 1000))}
          needed={gameData.vote.needed}
          voted={gameData.vote.voted}
          participants={gameData.vote.participants.length}
          myVote={gameData.vote.myVote}
          onVote={(targetId) => sendAction("vote", { targetId })}
        />
      )}

      {showClues && (
        <CluesPanel
          players={gameData.players}
          myId={self.id}
          clues={self.clues}
          onClose={() => setShowClues(false)}
        />
      )}
    </>
  );
}

interface TaskLineProps {
  download: { pointId: string; progress: number; here: boolean } | null;
  carriedPoint: TaskPoint | null;
  towerMeters: number | null;
  upload: { progress: number; here: boolean } | null;
  onUpload: () => void;
  nearestPoint: TaskPoint | null;
  nearestMeters: number;
  isBusy: boolean;
  onDownload: (pointId: string) => void;
  onDrop: () => void;
}

// What you are doing with tasks right now: downloading, carrying data, uploading it at its tower, or standing at a point.
function TaskLine({ download, carriedPoint, towerMeters, upload, onUpload, nearestPoint, nearestMeters, isBusy, onDownload, onDrop }: TaskLineProps) {
  const lineStyle = { fontSize: "0.75rem", fontFamily: "var(--tm-font-mono)", margin: 0 };

  if (download) {
    return (
      <>
        <div className="task-progress"><div style={{ width: `${Math.round(download.progress * 100)}%` }}></div></div>
        <div style={{ display: "flex", alignItems: "center", gap: "3cqw" }}>
          <p style={lineStyle}>
            {download.here
              ? `Downloading ${download.pointId} · ${Math.round(download.progress * 100)}%`
              : `Paused · go back to ${download.pointId}`}
          </p>
          <button onClick={onDrop} disabled={isBusy}>Cancel</button>
        </div>
      </>
    );
  }

  if (carriedPoint && upload) {
    return (
      <>
        <div className="task-progress"><div style={{ width: `${Math.round(upload.progress * 100)}%` }}></div></div>
        <div style={{ display: "flex", alignItems: "center", gap: "3cqw" }}>
          <p style={lineStyle}>
            {upload.here
              ? `Uploading ${carriedPoint.id} to tower ${carriedPoint.towerId} · ${Math.round(upload.progress * 100)}%`
              : `Paused · go back to tower ${carriedPoint.towerId}`}
          </p>
          <button onClick={onDrop} disabled={isBusy}>Drop</button>
        </div>
      </>
    );
  }

  if (carriedPoint && towerMeters !== null && towerMeters <= SITE_RANGE_M + 5) {
    return (
      <button data-variant="primary" style={{ width: "82cqw" }} disabled={isBusy} onClick={onUpload}>
        Upload {carriedPoint.id} to tower {carriedPoint.towerId}
      </button>
    );
  }

  if (carriedPoint) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "3cqw" }}>
        <p style={lineStyle}>
          Data {carriedPoint.id} → tower {carriedPoint.towerId}{towerMeters !== null ? ` · ${towerMeters} m` : ""}
        </p>
        <button onClick={onDrop} disabled={isBusy}>Drop</button>
      </div>
    );
  }

  if (nearestPoint && nearestMeters <= SITE_RANGE_M + 5) {
    return (
      <button data-variant="primary" style={{ width: "82cqw" }} disabled={isBusy} onClick={() => onDownload(nearestPoint.id)}>
        Download {nearestPoint.id}
      </button>
    );
  }

  return (
    <p style={{ ...lineStyle, color: "var(--tm-text-muted)" }}>
      {nearestPoint ? `Nearest point ${nearestPoint.id} · ${Math.round(nearestMeters)} m` : "Waiting for GPS..."}
    </p>
  );
}

interface TouchButtonsProps {
  gameData: GameState;
  now: number;
  isKiller: boolean;
  isBusy: boolean;
  onShare: (targetId: string) => void;
  onKill: (targetId: string) => void;
}

// Share (everyone) and Kill (killer only). Both fill up while the sonar hears someone within ~2 m
// for HOLD_S seconds, then work on that player (the one the sonar has heard the longest).
function TouchButtons({ gameData, now, isKiller, isBusy, onShare, onKill }: TouchButtonsProps) {
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

  const shareWait = gameData.self.shareCooldownUntil ? Math.ceil((gameData.self.shareCooldownUntil - now) / 1000) : 0;
  const killWait = gameData.self.killCooldownUntil ? Math.ceil((gameData.self.killCooldownUntil - now) / 1000) : 0;
  const inRange = target !== null && heldS >= HOLD_S;
  const percent = target === null ? 0 : Math.min(100, (heldS / HOLD_S) * 100);
  const width = isKiller ? "20cqw" : "27cqw";

  // fills like a progress bar until the sonar has heard the target long enough
  function fill(ready: boolean, waiting: boolean) {
    if (ready) return undefined;
    const shown = waiting ? 0 : percent;
    return `linear-gradient(to right, var(--tm-bg-active) ${shown}%, transparent ${shown}%)`;
  }

  let status = "";
  if (inRange && target) status = target.name;
  else if (target) status = "Stay close...";
  else if (gameData.sonarOn) status = "Nobody within 2 m";
  else status = "Nobody close";

  const shareReady = inRange && shareWait <= 0;
  const killReady = inRange && killWait <= 0;

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5cqh" }}>
        <button
          data-variant={shareReady ? "primary" : undefined}
          disabled={!shareReady || isBusy}
          onClick={() => {
            if (target) onShare(target.id);
          }}
          style={{ width, height: "6cqh", padding: 0, background: fill(shareReady, shareWait > 0) }}
        >
          {shareWait > 0 ? `${shareWait}s` : "Share"}
        </button>
        <p style={{ fontSize: "0.65rem", fontFamily: "var(--tm-font-mono)", margin: 0, maxWidth: width, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{status}</p>
      </div>
      {isKiller && (
        <button
          data-variant={killReady ? "primary" : undefined}
          disabled={!killReady || isBusy}
          onClick={() => {
            if (target) onKill(target.id);
          }}
          style={{ width, height: "6cqh", padding: 0, background: fill(killReady, killWait > 0) }}
        >
          {killWait > 0 ? `Kill ${minutes(killWait)}` : "Kill"}
        </button>
      )}
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
