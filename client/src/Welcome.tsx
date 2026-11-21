import "./Style.css";
import "./MapBackground";
import { useNavigate } from "react-router-dom";
import MapBackground from "./MapBackground";
import { useState } from "react";

export default function Welcome() {

    const navigate = useNavigate();
    const [username, setUsername] = useState(localStorage.getItem("username") ?? "");
    const [error, setError] = useState("");

    function enter() {
        const name = username.trim();
        if (!name) {
            setError("Username is required.");
            return;
        }
        if (name.length > 24) {
            setError("Username can be at most 24 characters.");
            return;
        }
        localStorage.setItem("username", name);
        navigate("/lobbies");
    }

    return (
    <>
      <div className="card"><p>Welcome</p></div>
      <p style={{ marginLeft:"1vw", marginTop:"0.1vh", fontSize:"0.75rem", fontFamily:"var(--tm-font-mono)"}}>United States - New York</p>

      <div className="main" style={{display:"flex", justifyContent:"center"}}>
        <div className="list card" style={{ width:"70vw", padding:"0vw 2vw 5vw 2vw"}}>
            <h4>Set your username:</h4>
            <hr></hr>
            <input
              style={{marginTop:"1vh"}}
              type="text"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") enter(); }}
            ></input>
            {error && <p role="alert" style={{ color: "#ff7070", margin: 0 }}>{error}</p>}
        </div>
        <button style={{ width: "50vw", height: "5vh" }} onClick={enter}>Enter</button>
      </div>
      <MapBackground/>
    </>
    );
}