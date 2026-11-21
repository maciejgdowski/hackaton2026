// An error that is safe to show the player, with the HTTP status to answer with.
export class GameError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
