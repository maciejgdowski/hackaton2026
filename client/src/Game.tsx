import GameBackgroundMap from "./GameBackgroundMap";

export default function GamePage() {
  return (
    <>
      <GameBackgroundMap>
        {/* You can pass game markers, circles, or polygons directly inside */}
      </GameBackgroundMap>

      <div className="game-hud-overlay">
        {/* Top bar */}
        <div className="game-bar">
          <div className="card" style={{ height:"7vh", width:"90vw", display:"flex", justifyContent:"center", alignItems:"center"}}><p>Clues: 6/9</p></div>
        </div>

        {/* Bottom controls */}
        <div className="game-bar">
          <div className="card" style={{ height:"12vh", width:"70vw", display:"flex", justifyContent:"center", alignItems:"center"}}><h3>Action</h3 ></div>
        </div>
      </div>
    </>
  );
}