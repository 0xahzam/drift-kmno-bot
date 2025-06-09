import { Connection } from "@solana/web3.js";
import { log } from "./logger";

// Load environment variables
const RPC_HTTP = Bun.env.RPC_ENDPOINT;
const RPC_WS = Bun.env.RPC_WS;
const PRIVATE_KEY = Bun.env.PRIVATE_KEY;

// Validation with proper logging
if (!RPC_HTTP || !RPC_WS) {
  log.error(
    "CONFIG",
    "Missing RPC endpoints",
    new Error("Environment variables not set")
  );
  process.exit(1);
}

if (!PRIVATE_KEY) {
  log.error(
    "CONFIG",
    "Missing PRIVATE_KEY in environment",
    new Error("PRIVATE_KEY not found")
  );
  process.exit(1);
}

// Trading parameters
export const TRADING_CONFIG = {
  DRIFT_QUANTITY: 10,
  KMNO_QUANTITY: 100,
  PRICE_RATIO: 10,
  SIGNAL_LAG_PERIODS: 2,
  CYCLE_INTERVAL_MS: 7 * 900_000, // 7 * 15min
  SIMULATION_MODE: false,
  ENV: "mainnet-beta" as const,
};

// Risk parameters
export const RISK_CONFIG = {
  MAX_SLIPPAGE_BPS: 25,
  CLOSE_MAX_SLIPPAGE_BPS: 50,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
};

// Export credentials (keep private)
export const config = {
  RPC_HTTP,
  RPC_WS,
  PRIVATE_KEY,
};

// Connection
export const connection = new Connection(RPC_HTTP, {
  wsEndpoint: RPC_WS,
  commitment: "confirmed",
});

log.cycle(0, "Configuration loaded", {
  simulation: TRADING_CONFIG.SIMULATION_MODE,
  env: TRADING_CONFIG.ENV,
  rpcConfigured: true,
});
