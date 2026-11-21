import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./Style.css";
import { Router, useNavigate } from "react-router-dom";

import "./MapBackground";

import { MapContainer, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import MapBackground from "./MapBackground";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

type SocketStatus = "connecting" | "connected" | "disconnected" | "error";

function App() {
  const [message, setMessage] = useState("");
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("connecting");
  const [connectedCount, setConnectedCount] = useState(0);

  const userName = "daw123";

  const navigate = useNavigate();

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
      <div className="card"><p>Hello, {userName}!</p></div>
      <p style={{ marginLeft:"1vw", marginTop:"0.1vh", fontSize:"0.75rem", fontFamily:"var(--tm-font-mono)"}}>United States - New York</p>

      <div className="main">
        <div className="card" style={{ width:"70vw"}}>
          <h4>Lobbies</h4>
          <div className="list" style={{ paddingBottom: "1vh" }}>
            <LobbyTile title="Lobby 1" id="0"/>
            <LobbyTile title="Lobby 2" id="1"/>
            <LobbyTile title="Lobby 3" id="2"/>
            <LobbyTile title="Lobby 4" id="3"/>
            <LobbyTile title="Lobby 5" id="4"/>
          </div>
        </div>
        <button className="create-button" onClick={() => navigate("/create")}>Create Lobby</button>
      </div>
      <MapBackground/>
    </>
  );
}

interface LobbyTileProps {
  title: string
  id: string
}

function LobbyTile(props : LobbyTileProps ) {
  const navigate = useNavigate();

  return (
    <>
      <hr></hr>
      <div className="element"><p>{props.title}</p><button style={{ height: "5vh" }} onClick={() => navigate(`/lobby/${props.id}`)}>Join</button></div>
    </>
  )
}

export default App;
