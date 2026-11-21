// Types shared by the server (what it sends) and the client (what it reads).

export type Phase = 'lobby' | 'playing' | 'ended';
export type Role = 'impostor' | 'regular';

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface Zone {
  latitude: number;
  longitude: number;
  radius: number;
}

/** Frequency plan: slot n plays base + n × spacing Hz. */
export interface SonarConfig {
  base: number;
  spacing: number;
  slots: number;
}

export interface LobbyInfo {
  code: string | null;
  radius: number;
  maxPlayers: number;
}

export interface PlayerSummary {
  id: string;
  name: string;
  slot: number;
  alive: boolean;
  sound: boolean;
}

export interface Self {
  id: string;
  name: string;
  slot: number;
  role: Role | null;
  alive: boolean;
}

/** One entry of the map snapshot this player is allowed to see. */
export interface Position {
  id: string;
  location: (LocationFix & { recordedAt: number }) | null;
}

export interface GameResult {
  winner: Role;
  reason: string;
  impostorId: string;
  impostorName: string;
  endedAt: number;
  killedByName: string | null;
}

/** GPS age/accuracy summary used by the ?debug=1 readout. */
export interface FixSummary {
  acc: number;
  age: number;
}

export interface SonarGate {
  on: boolean;
  why: string;
  me: FixSummary | null;
  nearest: (FixSummary & { m: number }) | null;
}

/** GET /api/state: everything one player's phone needs. */
export interface GameView {
  phase: Phase;
  serverTime: number;
  hostId: string | null;
  lobby: LobbyInfo;
  self: Self;
  players: PlayerSummary[];
  sonar: SonarConfig;
  sonarOn: boolean;
  gate?: SonarGate;
  zone: Zone | null;
  endsAt: number | null;
  killCooldownUntil: number | null;
  result: GameResult | null;
  positions: Position[];
  nextUpdateAt: number | null;
}

/** POST /api/create and /api/join */
export interface JoinResponse {
  token: string;
  code: string;
}

export interface CreateLobbyRequest {
  name: string;
  radius: number;
  maxPlayers: number;
}

export interface JoinLobbyRequest {
  name: string;
  code: string;
}
