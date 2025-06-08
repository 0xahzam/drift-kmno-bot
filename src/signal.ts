import { TRADING_CONFIG } from "./config";
import type { Signal, CandleData, Result } from "./types";

// Calculate price spread between DRIFT and KMNO
export function calculateSpread(driftPrice: number, kmnoPrice: number): number {
  return driftPrice - TRADING_CONFIG.PRICE_RATIO * kmnoPrice;
}

// Generate trading signal from spread
export function generateSignal(spread: number): Signal {
  if (spread < 0) return 1; // Long DRIFT, Short KMNO
  if (spread > 0) return -1; // Short DRIFT, Long KMNO
  return 0; // Flat
}

// Determine if position should change
export function shouldChangePosition(
  currentSignal: Signal,
  newSignal: Signal
): boolean {
  return currentSignal !== newSignal;
}

// Validate candle data quality
export function validateCandleData(
  driftCandles: CandleData[],
  kmnoCandles: CandleData[]
): Result<void> {
  const required = TRADING_CONFIG.SIGNAL_LAG_PERIODS + 1;

  if (driftCandles.length < required) {
    return {
      success: false,
      error: `Insufficient DRIFT data: ${driftCandles.length}/${required}`,
    };
  }

  if (kmnoCandles.length < required) {
    return {
      success: false,
      error: `Insufficient KMNO data: ${kmnoCandles.length}/${required}`,
    };
  }

  // Check for valid prices
  const driftPrice =
    driftCandles[TRADING_CONFIG.SIGNAL_LAG_PERIODS]?.oracleClose;
  const kmnoPrice = kmnoCandles[TRADING_CONFIG.SIGNAL_LAG_PERIODS]?.oracleClose;

  if (!driftPrice || !kmnoPrice || driftPrice <= 0 || kmnoPrice <= 0) {
    return { success: false, error: "Invalid price data" };
  }

  return { success: true, data: undefined };
}

// Main signal calculation with validation
export function calculateSignal(
  driftCandles: CandleData[],
  kmnoCandles: CandleData[]
): Result<{
  signal: Signal;
  spread: number;
  driftPrice: number;
  kmnoPrice: number;
}> {
  // Validate input data
  const validation = validateCandleData(driftCandles, kmnoCandles);
  if (!validation.success) {
    return validation;
  }

  // Extract lagged prices
  const lagIndex = TRADING_CONFIG.SIGNAL_LAG_PERIODS;
  const driftPrice = driftCandles[lagIndex]!.oracleClose;
  const kmnoPrice = kmnoCandles[lagIndex]!.oracleClose;

  // Calculate spread and signal
  const spread = calculateSpread(driftPrice, kmnoPrice);
  const signal = generateSignal(spread);

  return {
    success: true,
    data: { signal, spread, driftPrice, kmnoPrice },
  };
}
