import { env } from "@test-evals/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { runsRouter } from "./api/runs";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.get("/", (c) => c.text("OK"));

app.route("/api/v1/runs", runsRouter);

// Pin the port explicitly so it doesn't default to Bun's 3000 (collides with
// downstream NEXT_PUBLIC_SERVER_URL + CORS_ORIGIN expectations across the
// monorepo). Override via PORT=… if you ever need to.
const port = Number(process.env.PORT ?? 8787);

export default {
  port,
  fetch: app.fetch,
};
