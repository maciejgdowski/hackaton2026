import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import NotFound from './NotFound.tsx'
import Game from './Game.tsx'
import Lobby from './Lobby.tsx'
import Create from './Create.tsx'
import Welcome from './Welcome.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/welcome" element={ <Welcome /> } />
        <Route path="/" element={<App />} />
        <Route path="/lobby/:lobbyId" element={<Lobby />} />
        <Route path="/game/:gameId" element={<Game />} />
        <Route path="/create" element= {<Create />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
)
