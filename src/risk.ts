import { RISK_CONFIG } from "./config";
import { log } from "./logger";
import type { Result, LiquidityCheck } from "./types";

// Slippage validation
export function validateSlippage(
  slippage: number,
  isClosing: boolean = false
): Result<void> {
  const maxSlippage = isClosing
    ? RISK_CONFIG.CLOSE_MAX_SLIPPAGE_BPS
    : RISK_CONFIG.MAX_SLIPPAGE_BPS;
  const maxSlippageDecimal = maxSlippage / 10000;

  if (slippage > maxSlippageDecimal) {
    return {
      success: false,
      error: `Slippage too high: ${(slippage * 100).toFixed(3)}% > ${(
        maxSlippageDecimal * 100
      ).toFixed(3)}%`,
    };
  }
  return { success: true, data: undefined };
}

// Liquidity validation
export function validateLiquidity(
  liquidityCheck: LiquidityCheck,
  isClosing: boolean = false
): Result<void> {
  if (!liquidityCheck.canFill) {
    return {
      success: false,
      error: "Insufficient market liquidity",
    };
  }

  return validateSlippage(liquidityCheck.estimatedSlippage, isClosing);
}

// Pre-trade validation
export function validateTrade(
  driftLiquidity: LiquidityCheck,
  kmnoLiquidity: LiquidityCheck,
  isClosing: boolean = false
): Result<void> {
  // Check DRIFT liquidity
  const driftCheck = validateLiquidity(driftLiquidity, isClosing);
  if (!driftCheck.success) {
    return { success: false, error: `DRIFT: ${driftCheck.error}` };
  }

  // Check KMNO liquidity
  const kmnoCheck = validateLiquidity(kmnoLiquidity, isClosing);
  if (!kmnoCheck.success) {
    return { success: false, error: `KMNO: ${kmnoCheck.error}` };
  }

  return { success: true, data: undefined };
}

// Position reconciliation validation
export function validatePositionReconciliation(
  internalPosition: Position | null,
  exchangePosition: Position | null,
  tolerance: number = 0.1
): Result<{ needsCorrection: boolean; corrections?: Position }> {
  // No positions on either side
  if (!internalPosition && !exchangePosition) {
    return { success: true, data: { needsCorrection: false } };
  }

  // Position exists only on one side
  if (!internalPosition || !exchangePosition) {
    log.risk("Position mismatch detected", {
      internal: internalPosition,
      exchange: exchangePosition,
    });
    return {
      success: true,
      data: {
        needsCorrection: true,
        corrections: exchangePosition || undefined,
      },
    };
  }

  // Check for drift in position sizes
  //@ts-ignore
  const driftDiff = Math.abs(internalPosition.drift - exchangePosition.drift);
  //@ts-ignore
  const kmnoDiff = Math.abs(internalPosition.kmno - exchangePosition.kmno);

  if (driftDiff > tolerance || kmnoDiff > tolerance) {
    log.risk("Position drift detected", {
      driftDiff,
      kmnoDiff,
      tolerance,
      internal: internalPosition,
      exchange: exchangePosition,
    });

    return {
      success: true,
      data: {
        needsCorrection: true,
        corrections: exchangePosition,
      },
    };
  }

  return { success: true, data: { needsCorrection: false } };
}
