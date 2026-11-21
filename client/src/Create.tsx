import "./MapBackground";
import MapBackground from "./MapBackground";
import "./Style.css";
import { useNavigate, useParams } from "react-router-dom";
import "./LocationPickerMap";
import LocationPickerMap, { type Coordinates } from "./LocationPickerMap";
import { useState } from "react";

export default function Create() {

const params = useParams();
const navigate = useNavigate();

const [location, setLocation] = useState<Coordinates | null>(null);

return (
    <>
      <div className="card"><p>Creating lobby</p></div>
      <p style={{ marginLeft:"1vw", marginTop:"0.1vh", fontSize:"0.75rem", fontFamily:"var(--tm-font-mono)"}}>United States - New York</p>

      <div className="main">
        <div className="card" style={{ width:"70vw"}}>
          <h4>Your Lobby</h4>
          <div className="list" style={{ paddingBottom: "1vh", maxHeight:"50vh"}}>
                <hr></hr>
                <p className="annotation">Name:</p> <input style={{width: "50vw"}} type="text" placeholder="name"></input>
                <hr></hr>
                <p className="annotation">Player count:</p> <input style={{width: "50vw"}} type="number" placeholder="2-8" min="2" max="8"></input>
                <hr></hr>
                <p className="annotation">Hunter count:</p> <input style={{width: "50vw"}} type="number" placeholder="1-2" min="1" max="2"></input>
                <hr></hr>
                <p className="annotation">Map size:</p>
                <select style={{width: "50vw"}} defaultValue={"md"}>
                  <option value="lg">Large</option>
                  <option value="md">Medium (Default)</option>
                  <option value="sm">Small</option>
                </select>
                <hr></hr>
                <p className="annotation">Clues:</p>
                <select style={{width: "50vw"}} defaultValue={"md"}>
                  <option value="lg">Dense</option>
                  <option value="md" >Normal (Default)</option>
                  <option value="sm">Sparse</option>
                </select>
                <p className="annotation">Location</p>
                <LocationPickerMap value={location} onChange={setLocation} />
          </div>
        </div>
        <div style={{ display:"flex", gap:"10vw"}}>
          <button className="create-button" style={{ width:"30vw" }} onClick={() => navigate("/")}>Back</button>
          <button className="create-button" style={{ width:"30vw" }} onClick={() => navigate("/lobby/0")}>Create</button>
        </div>
      </div>
      <MapBackground/>
    </>
  );
}