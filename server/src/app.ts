import express, { type Express, type Request, type Response } from "express";
import morgan from "morgan";
import cors from "cors";
import { env } from "./env.ts";
import { Server, type Socket } from "socket.io";
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


interface LobbyProps {
  radius: "small" | "medium" | "large";
  center: { lat: number; lng: number };
  hunters: 1 | 2;
  clues: "easy" | "medium" | "hard";
}

interface LobbyState {
  props: LobbyProps;
  members: Set<string>;
}

const lobbies = new Map<string, LobbyState>();

type LobbyResponse = {
  ok: boolean;
  lobbyId?: string;
  memberCount?: number;
  lobbyProps?: LobbyProps;
  error?: string;
};

type LobbyAck = (response: LobbyResponse) => void;

function isLobbyProps(value: unknown): value is LobbyProps {
  if (!value || typeof value !== "object") return false;

  const props = value as Partial<LobbyProps>;
  const center = props.center;

  return (
    (props.radius === "small" || props.radius === "medium" || props.radius === "large") &&
    !!center &&
    typeof center.lat === "number" &&
    Number.isFinite(center.lat) &&
    center.lat >= -90 &&
    center.lat <= 90 &&
    typeof center.lng === "number" &&
    Number.isFinite(center.lng) &&
    center.lng >= -180 &&
    center.lng <= 180 &&
    (props.hunters === 1 || props.hunters === 2) &&
    (props.clues === "easy" || props.clues === "medium" || props.clues === "hard")
  );
}

function reply(ack: LobbyAck | undefined, response: LobbyResponse) {
  ack?.(response);
}

function emitLobbyCount(lobbyId: string) {
  const memberCount = lobbies.get(lobbyId)?.members.size ?? 0;
  io.to(`lobby:${lobbyId}`).emit("lobby:count", memberCount);
}

function getLobbyList() {
  return Array.from(lobbies.keys());
}

function emitLobbyList() {
  io.emit("lobbies:update", getLobbyList());
}

function removeFromLobby(socketId: string, lobbyId: string) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return;

  lobby.members.delete(socketId);
  if (lobby.members.size === 0) {
    lobbies.delete(lobbyId);
    emitLobbyList();
    return;
  }
  emitLobbyCount(lobbyId);
}

function joinLobby(socket: Socket, lobbyId: string, ack: LobbyAck) {
  const currentLobbyId = socket.data.lobbyId as string | undefined;
  const lobby = lobbies.get(lobbyId);

  if (!lobby) {
    reply(ack, { ok: false, error: "Lobby not found. Check the ID and try again." });
    return;
  }

  if (currentLobbyId === lobbyId) {
    reply(ack, {
      ok: true,
      lobbyId,
      memberCount: lobby.members.size,
      lobbyProps: lobby.props,
    });
    return;
  }

  if (currentLobbyId) {
    socket.leave(`lobby:${currentLobbyId}`);
    removeFromLobby(socket.id, currentLobbyId);
    delete socket.data.lobbyId;
  }

  lobby.members.add(socket.id);
  socket.data.lobbyId = lobbyId;
  socket.join(`lobby:${lobbyId}`);
  reply(ack, {
    ok: true,
    lobbyId,
    memberCount: lobby.members.size,
    lobbyProps: lobby.props,
  });
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

  socket.on("create_lobby", (props: unknown, ack?: LobbyAck) => {
    if (!isLobbyProps(props)) {
      reply(ack, {
        ok: false,
        error: "Invalid lobby settings. Check radius, center, hunters, and clues.",
      });
      return;
    }

    let lobbyId: string;
    do {
      lobbyId = randomUUID().slice(0, 8).toUpperCase();
    } while (lobbies.has(lobbyId));

    lobbies.set(lobbyId, { props, members: new Set() });
    emitLobbyList();
    joinLobby(socket, lobbyId, (response) => {
      reply(ack, response);
    });
  });

  socket.on("join_lobby", (requestedLobbyId: unknown, ack?: LobbyAck) => {
    if (typeof requestedLobbyId !== "string" || !requestedLobbyId.trim()) {
      reply(ack, { ok: false, error: "Enter a lobby ID." });
      return;
    }

    joinLobby(socket, requestedLobbyId.trim().toUpperCase(), (response) => {
      reply(ack, response);
    });
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
