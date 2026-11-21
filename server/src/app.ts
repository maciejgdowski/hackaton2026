import express, { type Express, type Request, type Response } from "express";
import morgan from "morgan";
import cors from "cors";
import { env } from "./env.ts";
import { WebSocket, WebSocketServer } from "ws";
import http, { IncomingMessage } from 'http';
import { Duplex } from "stream";

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
  hunters: 1 | 2;
  clues: "easy" | "medium" | "hard";
}

interface LobbyState {
  name: string;
  props: LobbyProps;
  members: Map<string, string>; // UUID -> username
}

interface GameWebSocket extends WebSocket {
  userId?: string;
  gameId?: string;
  lobbyId?: string;
}

const lobbies = new Map<string, LobbyState>();
const lobbySockets = new Map<string, Set<WebSocket>>();

function serializeLobby(lobbyId: string, lobby: LobbyState) {
  return { ...lobby, id: lobbyId, members: Object.fromEntries(lobby.members) };
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

  const { radius, center, players, hunters, clues, username } = req.body;
  const validRadii = ["small", "medium", "large"];
  const validClues = ["easy", "medium", "hard"];

  if (!validRadii.includes(radius) || !validClues.includes(clues)) {
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
  if (!Number.isInteger(hunters) || (hunters !== 1 && hunters !== 2)) {
    res.status(400).json({ error: "Hunter count must be 1 or 2" });
    return;
  }

  const lobbyId = crypto.randomUUID();
  const lobbyName = typeof username === "string" && username.trim() ? username.trim() : "Lobby";
  const lobbyState: LobbyState = {
    name: lobbyName,
    props: { radius, center, players, hunters, clues },
    members: new Map([[userId, lobbyName]]),
  };
  lobbies.set(lobbyId, lobbyState);
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
  if (!client.lobbyId) return;

  const sockets = lobbySockets.get(client.lobbyId) ?? new Set<WebSocket>();
  sockets.add(socket);
  lobbySockets.set(client.lobbyId, sockets);

  const lobby = lobbies.get(client.lobbyId);
  if (lobby) {
    socket.send(JSON.stringify({ type: "lobby:update", lobby: serializeLobby(client.lobbyId, lobby) }));
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

app.get("/lobbies", (_req: Request, res: Response) => {
  const lobbyList = Array.from(lobbies, ([id, lobby]) => ({
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
  broadcastLobbyUpdate(lobbyId);
  for (const socket of lobbySockets.get(lobbyId) ?? []) socket.close(1000, "Lobby disbanded");
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
  if (!lobby.members.has(userId) && lobby.members.size >= lobby.props.players) {
    res.status(409).json({ error: "This lobby is full." });
    return;
  }

  if (!lobby.members.has(userId)) {
    const username = typeof req.body.username === "string" && req.body.username.trim()
      ? req.body.username.trim()
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
  if (lobby.members.size === 0) lobbies.delete(lobbyId);
  broadcastLobbyUpdate(lobbyId);
  res.status(204).end();
});

server.listen(env.PORT, () => {
  console.log(`Backend API listening on port ${env.PORT}`);
});
