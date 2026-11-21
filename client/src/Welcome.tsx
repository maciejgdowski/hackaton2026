import "./Style.css";
import "./MapBackground";
import { useNavigate } from "react-router-dom";
import MapBackground from "./MapBackground";

export default function Welcome() {

    const navigate = useNavigate();

    return (
    <>
      <div className="card"><p>Welcome</p></div>
      <p style={{ marginLeft:"1vw", marginTop:"0.1vh", fontSize:"0.75rem", fontFamily:"var(--tm-font-mono)"}}>United States - New York</p>

      <div className="main" style={{display:"flex", justifyContent:"center"}}>
        <div className="list card" style={{ width:"70vw", padding:"0vw 2vw 5vw 2vw"}}>
            <h4>Set your username:</h4>
            <hr></hr>
            <input style={{marginTop:"1vh"}} type="text" placeholder="username"></input>
        </div>
        <button style={{ width: "50vw", height: "5vh" }} onClick={() => navigate("/")}>Enter</button>
      </div>
      <MapBackground/>
    </>
    );
}