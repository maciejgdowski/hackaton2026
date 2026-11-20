import express, { type Express, type Request, type Response } from "express";
import morgan from "morgan";
import cors from "cors";
import { env } from "./env.ts";
import { Server, Socket } from "socket.io";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const allowedOrigins = (env.WEB_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const app: Express = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

app.use(morgan("dev"));
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


const connectedSockets = new Set<string>();
const lobbies = new Map<string, Set<string>>();

type LobbyResponse = {
  ok: boolean;
  lobbyId?: string;
  memberCount?: number;
  error?: string;
};

type LobbyAck = (response: LobbyResponse) => void;

function emitLobbyCount(lobbyId: string) {
  const memberCount = lobbies.get(lobbyId)?.size ?? 0;
  io.to(`lobby:${lobbyId}`).emit("lobby:count", memberCount);
}

function getLobbyList() {
  return Array.from(lobbies.keys());
}

function emitLobbyList() {
  io.emit("lobbies:update", getLobbyList());
}

function removeFromLobby(socketId: string, lobbyId: string) {
  const members = lobbies.get(lobbyId);
  if (!members) return;

  members.delete(socketId);
  if (members.size === 0) {
    lobbies.delete(lobbyId);
    emitLobbyList();
  }
  emitLobbyCount(lobbyId);
}

function joinLobby(socket: Socket, lobbyId: string, ack: LobbyAck) {
  const currentLobbyId = socket.data.lobbyId as string | undefined;
  if (currentLobbyId === lobbyId) {
    ack({ ok: true, lobbyId, memberCount: lobbies.get(lobbyId)?.size ?? 1 });
    return;
  }

  const members = lobbies.get(lobbyId);
  if (!members) {
    ack({ ok: false, error: "Lobby not found. Check the ID and try again." });
    return;
  }

  if (currentLobbyId) {
    socket.leave(`lobby:${currentLobbyId}`);
    removeFromLobby(socket.id, currentLobbyId);
    delete socket.data.lobbyId;
  }

  members.add(socket.id);
  socket.data.lobbyId = lobbyId;
  socket.join(`lobby:${lobbyId}`);
  ack({ ok: true, lobbyId, memberCount: members.size });
  emitLobbyCount(lobbyId);
}

app.get("/", (req: Request, res: Response) => {
  res.send("Hello World!");
});
app.get("/health", (req: Request, res: Response) => {
  res.json({ message: "Hello from the backend!" });
});


io.on("connection", (socket) => {
  connectedSockets.add(socket.id);
  io.emit("socketCount", connectedSockets.size);

  socket.on("create_lobby", (ack: LobbyAck) => {
    let lobbyId: string;
    do {
      lobbyId = randomUUID().slice(0, 8).toUpperCase();
    } while (lobbies.has(lobbyId));

    lobbies.set(lobbyId, new Set());
    emitLobbyList();
    joinLobby(socket, lobbyId, ack);
  });

  socket.on("join_lobby", (requestedLobbyId: string, ack: LobbyAck) => {
    if (typeof requestedLobbyId !== "string" || !requestedLobbyId.trim()) {
      ack({ ok: false, error: "Enter a lobby ID." });
      return;
    }

    joinLobby(socket, requestedLobbyId.trim().toUpperCase(), ack);
  });
  socket.on("list_lobbies", (ack?: (lobbyIds: string[]) => void) => {
    ack?.(getLobbyList());
  });
  
  socket.on("disconnect", () => {
    connectedSockets.delete(socket.id);
    io.emit("socketCount", connectedSockets.size);

    const lobbyId = socket.data.lobbyId as string | undefined;
    if (lobbyId) removeFromLobby(socket.id, lobbyId);
  });
});


server.listen(env.PORT, () => {
  console.log(`Backend API listening on port ${env.PORT}`);
});
