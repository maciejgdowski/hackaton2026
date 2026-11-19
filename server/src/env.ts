import dotenv from "dotenv";
import { z } from "zod";

if (process.env.VERCEL !== "1") {
  dotenv.config({ quiet: true });
}

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().optional().default("http://localhost:5173"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const missingKeys = parsed.error.issues
    .map((issue) => issue.path.join("."))
    .filter(Boolean)
    .join(", ");

  throw new Error(`Missing or invalid environment variables: ${missingKeys}`);
}

export const env = parsed.data;
