// Signal types
export type Signal = -1 | 0 | 1; // Short, Flat, Long

// Position state
export interface Position {
  drift: number;
  kmno: number;
  signal: Signal;
}

// Bot operational states
export type BotState =
  | "INITIALIZING"
  | "HEALTHY"
  | "DEGRADED" // Partial functionality (stale data, etc.)
  | "RISK_BREACH" // Risk limits hit, reduce-only mode
  | "EMERGENCY" // Critical failure, close all positions
  | "SHUTDOWN";

// Market data
export interface CandleData {
  oracleClose: number;
  timestamp?: number;
}

export interface LiquidityCheck {
  canFill: boolean;
  estimatedSlippage: number;
}

// Result type for error handling
export type Result<T, E = string> =
  | { success: true; data: T }
  | { success: false; error: E };

// Account state
export interface AccountState {
  totalCollateral: number;
  freeCollateral: number;
  unrealizedPnL: number;
}

// Risk metrics
export interface RiskMetrics {
  positionSize: number;
  leverage: number;
  dailyPnL: number;
  maxDrawdown: number;
}
