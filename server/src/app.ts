import express, { type Express, type Request, type Response } from "express";
import morgan from "morgan";
import cors from "cors";
import { env } from "./env.ts";
import { WebSocket, WebSocketServer } from "ws";
import http, { IncomingMessage } from 'http';
import { Duplex } from "stream";
import {
  castVote, createGame, dropData, kill, removePlayer, serializeGame, share, startDownload, startUpload, startVote,
  tickGame, updateHeard, updateLocation, GameError, ZONE_RADIUS_M, type Coordinates, type GameState, type Status,
} from "./game.ts";
import { checkArea, placeTasks } from "./places.ts";
import { distanceMeters } from "./game.ts";

const allowedOrigins = (env.WEB_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const app: Express = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(morgan("dev"));
app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / curl / server-to-server calls (no Origin header).
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS: origin '${origin}' is not allowed`));
    },
    credentials: true,
  }),
);


interface LobbyProps {
  radius: "small" | "medium" | "large";
  center: { lat: number; lng: number };
  players: number;
}

interface LobbyState {
  name: string;
  props: LobbyProps;
  members: Map<string, string>; // UUID -> username
  status: Status;
  game: GameState | null; // the current / last round
}

interface GameWebSocket extends WebSocket {
  userId?: string;
  gameId?: string;
  lobbyId?: string;
}

const lobbies = new Map<string, LobbyState>();
const lobbySockets = new Map<string, Set<WebSocket>>();
const gameSockets = new Map<string, Set<GameWebSocket>>();
const startingLobbies = new Set<string>(); // lobbies whose game is being set up right now
// Good spots for tasks inside each lobby's zone, checked with Mapbox in the background (see places.ts)
const lobbySpots = new Map<string, Promise<Coordinates[]>>();

// What a phone sends once a second: { type: "player:location", location: {...} }
interface PlayerLocation {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}

function isLocation(value: unknown): value is PlayerLocation {
  if (!value || typeof value !== "object") return false;
  const p = value as PlayerLocation;
  return Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 &&
    Number.isFinite(p.lng) && Math.abs(p.lng) <= 180 &&
    Number.isFinite(p.accuracy) && p.accuracy >= 0 &&
    Number.isFinite(p.timestamp) && p.timestamp > 0;
}

// Never send `game` here: it holds everyone's role and position.
function serializeLobby(lobbyId: string, lobby: LobbyState) {
  const { game: _game, ...rest } = lobby;
  return { ...rest, id: lobbyId, members: Object.fromEntries(lobby.members) };
}

// One player's view of the game, plus how many players are still in the lobby
// (when everyone else has quit, the phone goes back to the main menu).
function gameView(lobby: LobbyState, userId: string) {
  if (!lobby.game) return null;
  const game = serializeGame(lobby.game, userId);
  return game ? { ...game, membersLeft: lobby.members.size } : null;
}

// Every player gets their own view (role, sonar, map), so each socket gets its own message.
function broadcastGameUpdate(lobbyId: string) {
  const lobby = lobbies.get(lobbyId);
  for (const socket of gameSockets.get(lobbyId) ?? []) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    const game = lobby && socket.userId ? gameView(lobby, socket.userId) : null;
    socket.send(JSON.stringify(game ? { type: "game:update", game } : { type: "game:closed", gameId: lobbyId }));
  }
}

// Is this spot inside the lobby's play area? GPS can be off, so allow up to 25 m of its reported inaccuracy.
// Used so you can only host where you are, and only see / join lobbies you are standing in.
function isInsideZone(props: LobbyProps, location: unknown) {
  const spot = location as { lat?: unknown; lng?: unknown; accuracy?: unknown } | null;
  if (!spot || typeof spot.lat !== "number" || typeof spot.lng !== "number") return false;
  const accuracy = typeof spot.accuracy === "number" && spot.accuracy > 0 ? spot.accuracy : 0;
  const meters = distanceMeters(props.center, { lat: spot.lat, lng: spot.lng });
  return meters <= ZONE_RADIUS_M[props.radius] + Math.min(accuracy, 25);
}

function sendError(res: Response, error: unknown) {
  if (error instanceof GameError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Something went wrong." });
}

function broadcastLobbyUpdate(lobbyId: string) {
  const lobby = lobbies.get(lobbyId);
  const message = JSON.stringify(
    lobby
      ? { type: "lobby:update", lobby: serializeLobby(lobbyId, lobby) }
      : { type: "lobby:closed", lobbyId },
  );

  for (const socket of lobbySockets.get(lobbyId) ?? []) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

function authenticateUser(req: IncomingMessage): string | null {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  // Przykład: ws://localhost:3000/game/game-123?userId=user-1
  // Docelowo powinieneś tu zweryfikować token JWT lub sesję Expressa!
  return url.searchParams.get('userId');
}


app.post("/lobby/create", (req: Request, res: Response) => {
  const userId = authenticateUser(req);
  if (!userId) {
    res.status(401).json({ error: "A valid userId is required" });
    return;
  }

  const { name, radius, center, players, username, hostLocation } = req.body;
  const validRadii = ["small", "medium", "large"];

  if (!validRadii.includes(radius)) {
    res.status(400).json({ error: "Invalid lobby settings" });
    return;
  }
  if (!center || typeof center.lat !== "number" || typeof center.lng !== "number") {
    res.status(400).json({ error: "A valid center location is required" });
    return;
  }
  if (!Number.isInteger(players) || players < 2 || players > 8) {
    res.status(400).json({ error: "Player count must be between 2 and 8" });
    return;
  }

  if (!isInsideZone({ radius, center, players }, hostLocation)) {
    res.status(403).json({ error: "You have to be inside the play area to host it." });
    return;
  }

  const lobbyId = crypto.randomUUID();
  const playerName = typeof username === "string" && username.trim() ? username.trim().slice(0, 24) : "Player";
  const lobbyName = typeof name === "string" && name.trim() ? name.trim() : `${playerName}'s lobby`;
  const lobbyState: LobbyState = {
    name: lobbyName,
    props: { radius, center, players },
    members: new Map([[userId, playerName]]),
    status: "waiting",
    game: null,
  };
  lobbies.set(lobbyId, lobbyState);
  lobbySpots.set(lobbyId, checkArea(center, ZONE_RADIUS_M[radius as LobbyProps["radius"]]).catch(() => []));
  console.log(`Lobby created: ${lobbyId}`, lobbyState);
  res.status(201).json({ lobbyId });
});


server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  
  const match = url.pathname.match(/^\/(game|lobby)\/([^/]+)$/);
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const [, route, lobbyId] = match;
  const lobby = lobbies.get(lobbyId);

  // 2. Sprawdzamy czy gra istnieje
  if (!lobby) {
    socket.write('HTTP/1.1 404 Game Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // 3. Autoryzujemy użytkownika i sprawdzamy czy jest na liście
  const userId = authenticateUser(request);
  if (!userId || !lobby.members.has(userId)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // 4. Wszystko się zgadza -> finalizujemy połączenie WebSocket
  wss.handleUpgrade(request, socket, head, (ws) => {
    const gameWs = ws as unknown as GameWebSocket;
    gameWs.userId = userId;
    gameWs.gameId = route === "game" ? lobbyId : undefined;
    gameWs.lobbyId = route === "lobby" ? lobbyId : undefined;

    wss.emit('connection', gameWs, request);
  });
});

wss.on("connection", (socket) => {
  const client = socket as GameWebSocket;
  if (client.gameId && client.userId) {
    const gameId = client.gameId;
    const userId = client.userId;
    const lobby = lobbies.get(gameId);
    if (!lobby?.game || !lobby.game.players.has(userId)) {
      socket.close(1008, "Game is not running.");
      return;
    }

    const sockets = gameSockets.get(gameId) ?? new Set<GameWebSocket>();
    sockets.add(client);
    gameSockets.set(gameId, sockets);

    socket.on("message", (raw) => {
      const game = lobbies.get(gameId)?.game;
      if (!game || !game.players.has(userId)) {
        socket.close(1008, "You are no longer in this game."); return;
      }
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "player:location" && isLocation(message.location)) {
          updateLocation(game, userId, message.location);
        } else if (message.type === "player:nearby") {
          // sonar: which phones this one hears within ~2 m (for touching phones / votes)
          updateHeard(game, userId, message.slots);
        }
      } catch { /* Ignore malformed messages without interrupting other players. */ }
    });
    socket.on("close", () => {
      sockets.delete(client);
      if (sockets.size === 0) gameSockets.delete(gameId);
    });

    const game = gameView(lobby, userId);
    if (game) socket.send(JSON.stringify({ type: "game:update", game }));
    socket.send(JSON.stringify({ type: "location:start" }));
    return;
  }

  if (!client.lobbyId) return;

  const sockets = lobbySockets.get(client.lobbyId) ?? new Set<WebSocket>();
  sockets.add(socket);
  lobbySockets.set(client.lobbyId, sockets);

  const lobby = lobbies.get(client.lobbyId);
  if (lobby) {
    socket.send(JSON.stringify({ type: "lobby:update", lobby: serializeLobby(client.lobbyId, lobby) }));
    if (lobby.status === "playing") socket.send(JSON.stringify({ type: "game:started", gameId: client.lobbyId }));
  }

  socket.on("close", () => {
    sockets.delete(socket);
    if (sockets.size === 0) lobbySockets.delete(client.lobbyId!);
  });
});

app.get("/getNewUser", (req: Request, res: Response) => {
  const existingUserId = authenticateUser(req);
  res.json({ userId: existingUserId || crypto.randomUUID() });
});

// get lobby data
app.get("/lobby/:lobbyId", (req: Request, res: Response) => {
  const lobbyId = req.params.lobbyId as string;
  const lobby = lobbies.get(lobbyId);

  if (!lobby) {
    res.status(404).json({ error: "Lobby not found" });
    return;
  }

  res.json(serializeLobby(lobbyId, lobby));
});

// Only lobbies still waiting whose play area you stand in (?lat=&lng=&accuracy=), plus the ones you are already in (?userId=).
app.get("/lobbies", (req: Request, res: Response) => {
  const here = {
    lat: Number(req.query.lat),
    lng: Number(req.query.lng),
    accuracy: Number(req.query.accuracy) || 0,
  };
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  const lobbyList = Array.from(lobbies)
    .filter(([, lobby]) => lobby.members.has(userId) || (lobby.status === "waiting" && isInsideZone(lobby.props, here)))
    .map(([id, lobby]) => ({
      id,
      name: lobby.name,
      playerCount: lobby.members.size,
      maxPlayers: lobby.props.players,
    }));
  res.json(lobbyList);
});

app.delete("/lobby/:lobbyId", (req: Request, res: Response) => {
  const lobbyId = req.params.lobbyId as string;
  const lobby = lobbies.get(lobbyId);
  const userId = authenticateUser(req);

  if (!lobby) {
    res.status(404).json({ error: "Lobby not found" });
    return;
  }
  const adminId = lobby.members.keys().next().value;
  if (!userId || userId !== adminId) {
    res.status(403).json({ error: "Only the lobby admin can disband this lobby." });
    return;
  }

  lobbies.delete(lobbyId);
  lobbySpots.delete(lobbyId);
  broadcastLobbyUpdate(lobbyId);
  broadcastGameUpdate(lobbyId);
  for (const socket of lobbySockets.get(lobbyId) ?? []) socket.close(1000, "Lobby disbanded");
  for (const socket of gameSockets.get(lobbyId) ?? []) socket.close(1000, "Lobby disbanded");
  res.status(204).end();
});

app.post("/lobby/:lobbyId/join", (req: Request, res: Response) => {
  const lobbyId = req.params.lobbyId as string;
  const lobby = lobbies.get(lobbyId);
  const userId = authenticateUser(req);

  if (!lobby) {
    res.status(404).json({ error: "Lobby not found. It may have been closed or the server restarted." });
    return;
  }
  if (!userId) {
    res.status(401).json({ error: "A valid userId is required" });
    return;
  }
  if (!lobby.members.has(userId) && !isInsideZone(lobby.props, req.body?.location)) {
    res.status(403).json({ error: "You have to be inside this lobby's play area to join." });
    return;
  }
  if (!lobby.members.has(userId) && lobby.members.size >= lobby.props.players) {
    res.status(409).json({ error: "This lobby is full." });
    return;
  }

  if (lobby.status !== "waiting" && !lobby.members.has(userId)) {
    res.status(409).json({ error: "This game has already started." });
    return;
  }

  if (!lobby.members.has(userId)) {
    const username = typeof req.body.username === "string" && req.body.username.trim()
      ? req.body.username.trim().slice(0, 24)
      : "Player";
    lobby.members.set(userId, username);
    broadcastLobbyUpdate(lobbyId);
  }

  res.json({ success: true });
});

app.delete("/lobby/:lobbyId/leave", (req: Request, res: Response) => {
  const lobbyId = req.params.lobbyId as string;
  const lobby = lobbies.get(lobbyId);
  const userId = authenticateUser(req);

  if (!lobby) {
    res.status(404).json({ error: "Lobby not found" });
    return;
  }
  if (!userId || !lobby.members.has(userId)) {
    res.status(404).json({ error: "Player is not in this lobby" });
    return;
  }

  lobby.members.delete(userId);
  if (lobby.game) {
    removePlayer(lobby.game, userId);
    if (lobby.game.result) lobby.status = "finished";
    for (const socket of gameSockets.get(lobbyId) ?? []) {
      if (socket.userId === userId) socket.close(1000, "Left game.");
    }
  }
  if (lobby.members.size === 0) {
    lobbies.delete(lobbyId);
    lobbySpots.delete(lobbyId);
  }
  broadcastLobbyUpdate(lobbyId);
  broadcastGameUpdate(lobbyId);
  res.status(204).end();
});

// ---------- game ----------
// The lobby ID is also the game ID: /game/:gameId and the WebSocket at /game/:gameId?userId=...

// Admin starts the round: places the towers and points, picks the killer, gives every player a sonar slot,
// and tells the lobby page to move to /game/:gameId.
app.post("/lobby/:lobbyId/start", async (req: Request, res: Response) => {
  const lobbyId = req.params.lobbyId as string;
  const lobby = lobbies.get(lobbyId);
  const userId = authenticateUser(req);

  if (!lobby) {
    res.status(404).json({ error: "Lobby not found" });
    return;
  }
  const adminId = lobby.members.keys().next().value;
  if (!userId || userId !== adminId) {
    res.status(403).json({ error: "Only the lobby admin can start the game." });
    return;
  }
  if (lobby.status !== "waiting" || startingLobbies.has(lobbyId)) {
    res.status(409).json({ error: "This game is not waiting to start." });
    return;
  }
  if (lobby.members.size < 2) {
    res.status(409).json({ error: "At least two players are required." });
    return;
  }

  // The spots were checked in the background since the lobby was created (usually done by now).
  startingLobbies.add(lobbyId);
  try {
    const spots = await (lobbySpots.get(lobbyId) ?? Promise.resolve([]));
    const layout = placeTasks(lobby.props.center, ZONE_RADIUS_M[lobby.props.radius], lobby.members.size - 1, spots);
    lobby.game = createGame(lobby.members, lobby.props, layout);
  } catch (error) {
    sendError(res, error);
    return;
  } finally {
    startingLobbies.delete(lobbyId);
  }
  lobby.status = "playing";
  console.log(`Game started: ${lobbyId}`);

  const message = JSON.stringify({ type: "game:started", gameId: lobbyId });
  for (const socket of lobbySockets.get(lobbyId) ?? []) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
  broadcastLobbyUpdate(lobbyId);
  broadcastGameUpdate(lobbyId);
  res.json({ success: true, gameId: lobbyId });
});

// After a round ends the admin reopens the lobby for the next one.
app.post("/lobby/:lobbyId/reset", (req: Request, res: Response) => {
  const lobbyId = req.params.lobbyId as string;
  const lobby = lobbies.get(lobbyId);
  const userId = authenticateUser(req);

  if (!lobby) {
    res.status(404).json({ error: "Lobby not found" });
    return;
  }
  const adminId = lobby.members.keys().next().value;
  if (!userId || userId !== adminId) {
    res.status(403).json({ error: "Only the lobby admin can reset the game." });
    return;
  }
  if (lobby.status !== "finished") {
    res.status(409).json({ error: "The game is still running." });
    return;
  }

  lobby.status = "waiting";
  lobby.game = null;
  broadcastLobbyUpdate(lobbyId);
  broadcastGameUpdate(lobbyId);
  res.status(204).end();
});

// This player's view of the game (same payload as the "game:update" socket message).
app.get("/game/:gameId", (req: Request, res: Response) => {
  const gameId = req.params.gameId as string;
  const lobby = lobbies.get(gameId);
  const userId = authenticateUser(req);

  if (!lobby?.game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  const game = userId ? gameView(lobby, userId) : null;
  if (!game) {
    res.status(403).json({ error: "You are not in this game." });
    return;
  }
  res.json(game);
});

// Every game action below works the same way: check the game exists, run the rule from game.ts,
// then push fresh views to everyone. Errors from the rules come back as { error }.
function gameAction(req: Request, res: Response, action: (game: GameState, userId: string) => unknown) {
  const gameId = req.params.gameId as string;
  const lobby = lobbies.get(gameId);
  const userId = authenticateUser(req);

  if (!lobby?.game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }
  let outcome;
  try {
    outcome = action(lobby.game, userId ?? "");
  } catch (error) {
    sendError(res, error);
    return;
  }
  if (lobby.game.result) {
    lobby.status = "finished";
    broadcastLobbyUpdate(gameId);
  }
  broadcastGameUpdate(gameId);
  res.json(outcome ?? { success: true });
}

// Body: { targetId, action: "share" | "kill" }. The phone only allows this once the sonar says
// the target is within ~2 m. Share copies clues both ways; kill is the killer holding the button.
app.post("/game/:gameId/scan", (req: Request, res: Response) => {
  gameAction(req, res, (game, userId) => {
    if (req.body?.action === "kill") return kill(game, userId, req.body?.targetId);
    return share(game, userId, req.body?.targetId);
  });
});

// Body: { pointId }. Start downloading at a point (you have to stand at it).
app.post("/game/:gameId/download", (req: Request, res: Response) => {
  gameAction(req, res, (game, userId) => startDownload(game, userId, req.body?.pointId));
});

// Upload the data you carry at its tower (you have to stand at it).
app.post("/game/:gameId/upload", (req: Request, res: Response) => {
  gameAction(req, res, (game, userId) => startUpload(game, userId));
});

// Stop downloading / throw away the data you carry.
app.post("/game/:gameId/drop", (req: Request, res: Response) => {
  gameAction(req, res, (game, userId) => dropData(game, userId));
});

// Start a vote with everyone whose phone is touching yours.
app.post("/game/:gameId/vote/start", (req: Request, res: Response) => {
  gameAction(req, res, (game, userId) => startVote(game, userId));
});

// Body: { targetId } (null = skip).
app.post("/game/:gameId/vote", (req: Request, res: Response) => {
  gameAction(req, res, (game, userId) => castVote(game, userId, req.body?.targetId ?? null));
});

// Once a second: downloads, deliveries, votes, the zone rule, then push fresh views
// (sonar on/off follows GPS, map pings refresh, the game clock stays in sync).
setInterval(() => {
  for (const [lobbyId, lobby] of lobbies) {
    if (lobby.status !== "playing" || !lobby.game) continue;
    tickGame(lobby.game);
    if (lobby.game.result) {
      lobby.status = "finished";
      broadcastLobbyUpdate(lobbyId);
    }
    broadcastGameUpdate(lobbyId);
  }
}, 1000);

server.listen(env.PORT, () => {
  console.log(`Backend API listening on port ${env.PORT}`);
});

