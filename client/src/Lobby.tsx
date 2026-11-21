import "./Style.css";
import "./MapBackground";
import { useNavigate, useParams } from "react-router-dom";
import MapBackground from "./MapBackground";

export default function Lobby() {

    const navigate = useNavigate();
    const params = useParams();

    const isAdmin = false;

  return (
    <>
      <div className="card"><p>Waiting for host...</p></div>
      <p style={{ marginLeft:"1vw", marginTop:"0.1vh", fontSize:"0.75rem", fontFamily:"var(--tm-font-mono)"}}>United States - New York</p>

      <div className="main">
        <div className="card" style={{ width:"70vw"}}>
          <h4>Players (4)</h4>
          <div className="list" style={{ paddingBottom: "1vh" }}>
            <PlayerTile name="Player 1" id="0" role="admin"></PlayerTile>
            <PlayerTile name="Player 2" id="1" role="player"></PlayerTile>
            <PlayerTile name="Player 3" id="2" role="player"></PlayerTile>
            <PlayerTile name="Player 4" id="3" role="player"></PlayerTile>
          </div>
        </div>
        {isAdmin ? 
            (<button className="create-button" onClick={() => navigate("/Game")}>Start Game</button>) : 
            (<button className="create-button" onClick={() => navigate("/")}>Quit Lobby</button>) 
        }
      </div>
      <MapBackground/>
    </>
  );

  interface LobbyTileProps {
  name: string
  id: string
  role: string
}

function PlayerTile(props : LobbyTileProps ) {

  return (
    <>
      <hr></hr>
      <div className="element"><p>{props.name}</p><p style={{ fontSize:"0.75rem" }}>{props.role}</p></div>
    </>
  )
}
}