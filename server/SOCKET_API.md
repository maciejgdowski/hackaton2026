# Socket.IO API

The backend exposes a Socket.IO connection on the same host and port as the Express API (default: `http://localhost:4000`). These are Socket.IO events, not REST endpoints. The server implementation is in `server/src/app.ts`; the current React example is in `client/src/SocketExample.tsx`.

```tsx
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

function Example() {
  const socketRef = useRef<Socket | null>(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const socket = io(API_URL, { withCredentials: true });
    socketRef.current = socket;

    socket.on("connect", () => setStatus("connected"));
    socket.on("disconnect", () => setStatus("disconnected"));
    socket.on("connect_error", (error) => {
      console.error("Socket connection failed:", error);
      setStatus("error");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  // Use socketRef.current?.emit(...) in handlers after the socket is connected.
  return <p>Socket: {status}</p>;
}
```

Register event listeners before calling `socket.connect()` if using `{ autoConnect: false }`. Always remove the connection in the React effect cleanup so it does not persist after the component unmounts.

## Events

`→` means the frontend emits the event to the server. `←` means the server emits the event to connected frontend clients.

| Event | Direction | Payload / acknowledgement | Purpose |
| --- | --- | --- | --- |
| `socketCount` | ← server to all clients | `number` | Current number of connected Socket.IO sockets. Sent on connect and disconnect. This counts sockets/tabs, not unique people. |
| `create_lobby` | → client to server | Acknowledgement: `{ ok: boolean, lobbyId?: string, memberCount?: number, error?: string }` | Creates a lobby and joins the requesting socket to it. The generated ID is returned in the acknowledgement. |
| `join_lobby` | → client to server | First argument: lobby ID (`string`). Acknowledgement uses the same response shape as `create_lobby`. | Joins an existing lobby. IDs are case-insensitive; the server normalizes them to uppercase. A bad or missing ID returns `ok: false` and an `error`. |
| `list_lobbies` | → client to server | Acknowledgement: `string[]` | Returns the current lobby IDs. |
| `lobbies:update` | ← server to all clients | `string[]` | Pushes the lobby ID list when a lobby is created or removed. |
| `lobby:count` | ← server to members of a lobby | `number` | Current member count for the lobby. Sent to that lobby when someone joins or leaves. |

A successful create or join acknowledgement contains `{ ok: true, lobbyId, memberCount }`. The callback is a Socket.IO acknowledgement, so pass it as the final argument to `emit`:

```tsx
type LobbyResponse = {
  ok: boolean;
  lobbyId?: string;
  memberCount?: number;
  error?: string;
};

socketRef.current?.emit("create_lobby", (response: LobbyResponse) => {
  if (!response.ok || !response.lobbyId) {
    console.error(response.error ?? "Could not create lobby");
    return;
  }
  console.log("Created and joined lobby:", response.lobbyId);
});

const lobbyId = "AB12CD34";
socketRef.current?.emit(
  "join_lobby",
  lobbyId,
  (response: LobbyResponse) => {
    if (!response.ok || !response.lobbyId) {
      console.error(response.error ?? "Could not join lobby");
      return;
    }
    console.log("Joined lobby:", response.lobbyId);
  },
);
```

## Request and listen for lobby lists

The request uses an acknowledgement callback; it is not an event listener. The server also broadcasts changes through `lobbies:update`.

```tsx
const updateLobbyList = (lobbyIds: string[]) => {
  setAvailableLobbies(lobbyIds);
};

socket.on("lobbies:update", updateLobbyList);
socket.emit("list_lobbies", updateLobbyList);
```

Request the list when the socket connects, so a newly opened page gets the current state. Listen for `lobbies:update` as well, so other clients see changes without refreshing.

## Listen for live counts

```tsx
socket.on("socketCount", (count: number) => {
  setConnectedSocketCount(count);
});

socket.on("lobby:count", (count: number) => {
  setLobbyMemberCount(count);
});
```

The `lobby:count` event is only sent to a socket after it joins a lobby. Use the `memberCount` value in the create/join acknowledgement to initialize the UI, then listen for `lobby:count` for subsequent updates.

## Current behavior and limitations

- Each socket can be in one lobby at a time. Joining another lobby leaves the previous one.
- When the last member disconnects, that lobby is removed and `lobbies:update` is broadcast.
- Lobby data is stored in server memory; restarting the server clears all lobbies.
- `socketCount` is not a user count. A single person with multiple browser tabs creates multiple sockets.
- The current implementation is in-memory and intended for a single backend process. Multiple server instances need a shared Socket.IO adapter and shared lobby state to keep counts and lists consistent.
