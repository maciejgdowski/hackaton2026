import "./Style.css";
import "./MapBackground";
import { useNavigate } from "react-router-dom";
import MapBackground from "./MapBackground";
import { useState } from "react";
import { startSonar } from "./Sonar";
import { getPlaceName, requestLocation, savePlaceName } from "./Location";

export default function Welcome() {

    const navigate = useNavigate();
    const [username, setUsername] = useState(localStorage.getItem("username") ?? "");
    const [error, setError] = useState("");
    const [placeName, setPlaceName] = useState(getPlaceName());
    const [isEntering, setIsEntering] = useState(false);

    async function enter() {
        if (isEntering) return;
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
        setError("");
        setIsEntering(true);

        // Ask for the microphone and location now, so the game is ready to go.
        // startSonar must be called right away from the tap (phones only allow sound after a tap).
        const problems: string[] = [];
        const sound = startSonar().catch((soundError) => {
            problems.push(soundError instanceof Error ? soundError.message : "Could not start the microphone.");
        });
        const location = requestLocation()
            .then(async (coords) => {
                await savePlaceName(coords);
                setPlaceName(getPlaceName());
            })
            .catch((locationError) => {
                problems.push(locationError instanceof Error ? locationError.message : "Could not get your location.");
            });
        await Promise.all([sound, location]);
        setIsEntering(false);

        if (problems.length > 0) {
            // let them read what's missing, then go on anyway
            setError(`${problems.join(" ")} You can still play, but the game needs both.`);
            setTimeout(() => navigate("/lobbies"), 4000);
            return;
        }
        navigate("/lobbies");
    }

    return (
    <>
      <div className="card"><p>Welcome</p></div>
      <p style={{ marginLeft:"1cqw", marginTop:"0.1cqh", fontSize:"0.75rem", fontFamily:"var(--tm-font-mono)"}}>{placeName}</p>

      <div className="main" style={{display:"flex", justifyContent:"center"}}>
        <div className="list card" style={{ width:"70cqw", padding:"0cqw 2cqw 5cqw 2cqw"}}>
            <h4>Set your username:</h4>
            <hr></hr>
            <input
              style={{marginTop:"1cqh"}}
              type="text"
              placeholder="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") enter(); }}
            ></input>
            {error && <p role="alert" style={{ color: "#ff7070", margin: 0 }}>{error}</p>}
        </div>
        <button style={{ width: "50cqw", height: "5cqh" }} onClick={enter} disabled={isEntering}>{isEntering ? "Allow mic and location..." : "Enter"}</button>
      </div>
      <MapBackground/>
    </>
    );
}
