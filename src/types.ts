// Signal types
export type Signal = -1 | 0 | 1; // Short, Flat, Long

// Position state
export type Position = {
  drift: number;
  kmno: number;
  signal: Signal;
  [key: string]: any;
};

// Bot operational states
export enum BotState {
  INITIALIZING = "INITIALIZING",
  HEALTHY = "HEALTHY",
  DEGRADED = "DEGRADED", // Partial functionality (stale data, etc.)
  RISK_BREACH = "RISK_BREACH", // Risk limits hit, reduce-only mode
  EMERGENCY = "EMERGENCY", // Critical failure, close all positions
  SHUTDOWN = "SHUTDOWN",
}

// Market data
export type CandleData = {
  oracleClose: number;
  timestamp?: number;
};

export type LiquidityCheck = {
  canFill: boolean;
  estimatedSlippage: number;
};

// Result type for error handling
export type Result<T, E = string> =
  | { success: true; data: T }
  | { success: false; error: E };

// Account state
export type AccountState = {
  totalCollateral: number;
  freeCollateral: number;
  unrealizedPnL: number;
};
