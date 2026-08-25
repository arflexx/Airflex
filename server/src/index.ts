import "dotenv/config";
import { createApp } from "./app";
import logger from "./utils/logger";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV_VARS = [
  "JWT_SECRET",
  "DATABASE_URL",
  "ESCROW_CONTRACT_ADDRESS",
  "ENCRYPTION_KEY",
  "STELLAR_SERVER_SECRET",
] as const;

const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

if (missingVars.length > 0) {
  // Use console.error here — logger may not be fully initialised yet
  console.error(
    `[startup] Missing required environment variables: ${missingVars.join(", ")}\n` +
      `Copy server/.env.example to server/.env and fill in the values.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const app = createApp();
const PORT = parseInt(process.env["PORT"] ?? "3001", 10);

app.listen(PORT, () => {
  logger.info(
    { port: PORT, env: process.env["NODE_ENV"] ?? "development" },
    "AirFlex API started"
  );
});
