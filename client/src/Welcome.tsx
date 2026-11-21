import "./Style.css";
import "./MapBackground";
import { useNavigate } from "react-router-dom";
import MapBackground from "./MapBackground";
import { useEffect, useState } from "react";
import { getPlaceName } from "./Location";
import { checkPermissions } from "./Permissions";
import type { PermissionsStatus } from "./Permissions";
import PermissionsPanel from "./PermissionsPanel";

export default function Welcome() {

    const navigate = useNavigate();
    const [username, setUsername] = useState(localStorage.getItem("username") ?? "");
    const [error, setError] = useState("");
    const [placeName, setPlaceName] = useState(getPlaceName());
    const [permissions, setPermissions] = useState<PermissionsStatus | null>(null);
    const [showPermissions, setShowPermissions] = useState(false);
    const [openedByEnter, setOpenedByEnter] = useState(false);

    // See what the phone already allows (no prompts here, prompts only come from the Allow buttons)
    useEffect(() => {
        checkPermissions().then(setPermissions);
    }, []);

    function changePermissions(status: PermissionsStatus) {
        setPermissions(status);
        setPlaceName(getPlaceName()); // the location may have just been found
    }

    function saveName() {
        const name = username.trim();
        if (!name) {
            setError("Username is required.");
            return false;
        }
        if (name.length > 24) {
            setError("Username can be at most 24 characters.");
            return false;
        }
        localStorage.setItem("username", name);
        setError("");
        return true;
    }

    // Enter only saves the name. If the mic or location is missing, the permissions panel opens first.
    function enter() {
        if (!saveName()) return;
        const ready = permissions?.microphone === "allowed" && permissions?.location === "allowed";
        if (ready) {
            navigate("/lobbies");
            return;
        }
        setOpenedByEnter(true);
        setShowPermissions(true);
    }

    function openPermissions() {
        setOpenedByEnter(false);
        setShowPermissions(true);
    }

    const allAllowed = permissions !== null && permissions.microphone === "allowed" && permissions.location === "allowed";

    return (
    <>
      <div className="card"><p>Welcome</p></div>
      <p style={{ marginLeft:"1cqw", marginTop:"0.1cqh", fontSize:"0.75rem", fontFamily:"var(--tm-font-mono)"}}>{placeName}</p>

      <div className="main" style={{display:"flex", justifyContent:"center"}}>
        <div className="list card" style={{ width:"70cqw", padding:"0cqw 2cqw 5cqw 2cqw"}}>
            <h4>Set your username:</h4>
            <hr></hr>
            <div style={{ display: "flex", gap: "2cqw", alignItems: "center", marginTop: "1cqh" }}>
              <input
                style={{ flex: 1, minWidth: 0 }}
                type="text"
                placeholder="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") enter(); }}
              ></input>
              <button className="permissions-button" onClick={openPermissions} aria-label="Permissions">
                <span className={allAllowed ? "permission-dot on" : "permission-dot"}></span>
                Perms
              </button>
            </div>
            {error && <p role="alert" style={{ color: "#ff7070", margin: 0 }}>{error}</p>}
        </div>
        <button style={{ width: "50cqw", height: "5cqh" }} onClick={enter}>Enter</button>
      </div>
      {showPermissions && permissions && (
        <PermissionsPanel
          status={permissions}
          onChange={changePermissions}
          onClose={() => setShowPermissions(false)}
          onContinue={openedByEnter ? () => navigate("/lobbies") : undefined}
        />
      )}
      <MapBackground/>
    </>
    );
}
