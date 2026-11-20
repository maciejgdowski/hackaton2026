import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

type SocketStatus = "connecting" | "connected" | "disconnected" | "error";

function App() {
  const [message, setMessage] = useState("");
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("connecting");
  const [connectedCount, setConnectedCount] = useState(0);

  useEffect(() => {
    const socket = io(API_URL, {
      autoConnect: false,
      withCredentials: true,
    });

    socket.on("connect", () => setSocketStatus("connected"));
    socket.on("disconnect", () => setSocketStatus("disconnected"));

    socket.on("socketCount", (count: number) => {
      setConnectedCount(count);
    });
    socket.on("connect_error", (error) => {
      console.error("Socket connection error:", error);
      setSocketStatus("error");
    });
    socket.connect();

    const fetchMessage = async () => {
      await fetch(`${API_URL}/health`)
        .then((res) => res.json())
        .then((data) => setMessage(data.message))
        .catch((err) => console.error("Error: ", err));
    };

    fetchMessage();

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <>
      <h1>Hello World!</h1>
      <h4>{message}</h4>
      <p>Socket status: {socketStatus}</p>
      <p>Connected clients: {connectedCount}</p>
    </>
  );
}

export default App;
