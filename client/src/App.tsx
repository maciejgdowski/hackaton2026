import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL;

function App() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    const fetchMessage = async () => {
      await fetch(`${API_URL}/health`)
        .then((res) => res.json())
        .then((data) => setMessage(data.message))
        .catch((err) => console.error("Error: ", err));
    };

    fetchMessage();
  }, []);
  return (
    <>
      <h1>Hello World!</h1>
      <h4>{message}</h4>
    </>
  );
}

export default App;
