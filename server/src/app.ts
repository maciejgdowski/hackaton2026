import express, { type Express, type Request, type Response } from "express";
import morgan from "morgan";
import cors from "cors";
import { env } from "./env";

const allowedOrigins = (env.WEB_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const app: Express = express();
app.use(morgan("dev"));
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin / curl / server-to-server calls (no Origin header).
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS: origin '${origin}' is not allowed`));
    },
    credentials: true,
  }),
);

app.get("/", (req: Request, res: Response) => {
  res.send("Hello World!");
});
app.get("/health", (req: Request, res: Response) => {
  res.json({ message: "Hello from the backend!" });
});

app.listen(env.PORT, () => {
  console.log(`Backend API listening on port ${env.PORT}`);
});
