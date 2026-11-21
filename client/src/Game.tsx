import "./Style.css";
import { useParams } from "react-router-dom";

export default function Game() {

    const params = useParams();

  return (
    <div>
      <h1>Game Page</h1>
      <p>This is the game id: {params.gameId}</p>
    </div>
  );
}