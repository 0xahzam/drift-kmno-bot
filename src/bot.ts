import { TRADING_CONFIG } from "./config";
import { log } from "./logger";
import { calculateSignal, shouldChangePosition } from "./signal";
import { validateTrade } from "./risk";
import {
  initializeDrift,
  fetchMarketData,
  checkLiquidity,
  placeOrder,
  getCurrentPositions,
  getAccountState,
  cleanup,
} from "./drift";
import { PositionDirection } from "@drift-labs/sdk";
import type { Position, Result, Signal } from "./types";
import { BotState } from "./types";

export class TradingBot {
  private state: BotState = BotState.INITIALIZING;
  private position: Position | null = null;
  private cycleCount = 0;
  private isCycleRunning = false;
  private cycleInterval: NodeJS.Timeout | null = null;

  // Initialize the bot
  async initialize(): Promise<Result<void>> {
    try {
      log.cycle(0, "Bot initialization started");

      // Initialize Drift client
      const driftInit = await initializeDrift();
      if (!driftInit.success) {
        return driftInit;
      }

      // Reconstruct position state from exchange on startup
      await this.reconstructPositionState();

      this.state = BotState.HEALTHY;
      log.cycle(0, "Bot initialized successfully", { state: this.state });

      return { success: true, data: undefined };
    } catch (error) {
      this.state = BotState.EMERGENCY;
      return {
        success: false,
        error: `Bot initialization failed: ${(error as Error).message}`,
      };
    }
  }

  // Start trading operations
  start(): void {
    if (this.state !== BotState.HEALTHY) {
      log.error(
        "BOT",
        "Cannot start bot in non-healthy state",
        new Error(`Current state: ${this.state}`)
      );
      return;
    }

    log.cycle(0, "Starting trading operations");

    // Run first cycle immediately
    this.executeCycle();

    // Schedule periodic cycles
    this.cycleInterval = setInterval(() => {
      this.executeCycle();
    }, TRADING_CONFIG.CYCLE_INTERVAL_MS);
  }

  // Stop trading operations
  async stop(): Promise<void> {
    log.cycle(0, "Stopping bot");

    // Clear interval
    if (this.cycleInterval) {
      clearInterval(this.cycleInterval);
      this.cycleInterval = null;
    }

    // Wait for current cycle to complete
    while (this.isCycleRunning) {
      log.cycle(0, "Waiting for current cycle to complete");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Close any open positions
    if (this.position) {
      log.cycle(0, "Closing positions before shutdown");
      await this.closePosition();
    }

    // Cleanup resources
    await cleanup();

    log.cycle(0, "Bot stopped", { totalCycles: this.cycleCount });
  }

  // Main trading cycle
  private async executeCycle(): Promise<void> {
    if (this.isCycleRunning) {
      log.cycle(this.cycleCount + 1, "Previous cycle still running, skipping");
      return;
    }

    this.isCycleRunning = true;
    this.cycleCount++;
    const cycleStart = process.hrtime.bigint();

    try {
      log.cycle(this.cycleCount, "Cycle started");

      // Health check
      if (this.state === BotState.EMERGENCY) {
        log.cycle(this.cycleCount, "Bot in emergency state, closing positions");
        await this.closePosition();
        return;
      }

      // Fetch market data
      const marketDataResult = await fetchMarketData();
      if (!marketDataResult.success) {
        log.error(
          "CYCLE",
          "Failed to fetch market data",
          new Error(marketDataResult.error)
        );
        this.state = BotState.DEGRADED;
        return;
      }

      const { driftCandles, kmnoCandles } = marketDataResult.data;

      // Calculate signal
      const signalResult = calculateSignal(driftCandles, kmnoCandles);
      if (!signalResult.success) {
        log.error(
          "CYCLE",
          "Failed to calculate signal",
          new Error(signalResult.error)
        );
        return;
      }

      const { signal, spread, driftPrice, kmnoPrice } = signalResult.data;
      const signalStr = this.getSignalString(signal);

      log.cycle(this.cycleCount, "Market data processed", {
        driftPrice: driftPrice.toFixed(4),
        kmnoPrice: kmnoPrice.toFixed(4),
        spread: spread.toFixed(4),
        signal: signalStr,
      });

      // Determine if position change is needed
      const currentSignal = this.position?.signal || 0;
      if (shouldChangePosition(currentSignal, signal)) {
        await this.transitionPosition(signal);
      } else {
        log.cycle(this.cycleCount, "Holding current position", {
          current: this.getSignalString(currentSignal),
        });

        // Only reconcile when we're NOT making position changes
        await this.reconcilePosition();
      }

      // Log current state
      await this.logCurrentState();

      this.state = BotState.HEALTHY;
    } catch (error) {
      log.error("CYCLE", `Cycle ${this.cycleCount} failed`, error as Error);
      this.state = BotState.DEGRADED;
    } finally {
      const cycleTime = Number(process.hrtime.bigint() - cycleStart) / 1e6;
      log.cycle(this.cycleCount, "Cycle completed", {
        duration: `${cycleTime.toFixed(1)}ms`,
      });
      this.isCycleRunning = false;
    }
  }

  // Transition between positions
  private async transitionPosition(newSignal: Signal): Promise<void> {
    const currentSignal = this.position?.signal || 0;
    const currentStr = this.getSignalString(currentSignal);
    const newStr = this.getSignalString(newSignal);

    log.cycle(
      this.cycleCount,
      `Position transition: ${currentStr} -> ${newStr}`
    );

    try {
      // Close current position if exists
      if (this.position) {
        await this.closePosition();
      }

      // Open new position if signal is not flat
      if (newSignal !== 0) {
        await this.openPosition(newSignal);
      }
    } catch (error) {
      log.error("TRANSITION", "Position transition failed", error as Error);
      this.state = BotState.EMERGENCY;
    }
  }

  // Open new position
  private async openPosition(signal: Signal): Promise<void> {
    const signalStr = this.getSignalString(signal);
    log.position(`Opening ${signalStr} spread`);

    try {
      // Check liquidity for both legs
      const driftDirection =
        signal > 0 ? PositionDirection.LONG : PositionDirection.SHORT;
      const kmnoDirection =
        signal > 0 ? PositionDirection.SHORT : PositionDirection.LONG;

      const driftSide =
        driftDirection === PositionDirection.LONG ? "asks" : "bids";
      const kmnoSide =
        kmnoDirection === PositionDirection.LONG ? "asks" : "bids";

      const [driftLiquidity, kmnoLiquidity] = await Promise.all([
        checkLiquidity("DRIFT-PERP", driftSide, TRADING_CONFIG.DRIFT_QUANTITY),
        checkLiquidity("KMNO-PERP", kmnoSide, TRADING_CONFIG.KMNO_QUANTITY),
      ]);

      // Validate trade
      const validation = validateTrade(driftLiquidity, kmnoLiquidity, false);
      if (!validation.success) {
        log.error(
          "POSITION",
          "Trade validation failed",
          new Error(validation.error)
        );
        return;
      }

      // Execute orders sequentially for better control
      await placeOrder("DRIFT", driftDirection, TRADING_CONFIG.DRIFT_QUANTITY);
      await placeOrder("KMNO", kmnoDirection, TRADING_CONFIG.KMNO_QUANTITY);

      // Update internal state
      this.position = {
        drift: signal * TRADING_CONFIG.DRIFT_QUANTITY,
        kmno: -signal * TRADING_CONFIG.KMNO_QUANTITY,
        signal,
      };

      log.position(`Successfully opened ${signalStr} spread`, this.position);
    } catch (error) {
      log.error(
        "POSITION",
        `Failed to open ${signalStr} position`,
        error as Error
      );
      throw error;
    }
  }

  // Close current position
  private async closePosition(): Promise<void> {
    if (!this.position) {
      log.position("No position to close");
      return;
    }

    log.position("Closing position", this.position);

    try {
      // Close DRIFT position
      if (this.position.drift !== 0) {
        const direction =
          this.position.drift > 0
            ? PositionDirection.SHORT
            : PositionDirection.LONG;
        await placeOrder(
          "DRIFT",
          direction,
          Math.abs(this.position.drift),
          true
        );
      }

      // Close KMNO position
      if (this.position.kmno !== 0) {
        const direction =
          this.position.kmno > 0
            ? PositionDirection.SHORT
            : PositionDirection.LONG;
        await placeOrder("KMNO", direction, Math.abs(this.position.kmno), true);
      }

      this.position = null;
      log.position("Successfully closed position");
    } catch (error) {
      log.error("POSITION", "Failed to close position", error as Error);
      throw error;
    }
  }

  private async reconstructPositionState(): Promise<void> {
    const exchangeResult = await getCurrentPositions();
    if (exchangeResult.success && exchangeResult.data) {
      this.position = exchangeResult.data;
      log.cycle(0, "Reconstructed position from exchange", this.position);
    } else {
      this.position = null;
      log.cycle(0, "No existing positions found");
    }
  }

  private async reconcilePosition(): Promise<void> {
    try {
      const exchangeResult = await getCurrentPositions();
      if (!exchangeResult.success) {
        log.error(
          "RECONCILE",
          "Failed to get exchange positions",
          new Error(exchangeResult.error)
        );
        return;
      }

      const exchangePosition = exchangeResult.data;

      if (!this.position && !exchangePosition) {
        return;
      }

      const targetSignal = this.position?.signal || 0;
      const targetDrift = targetSignal * TRADING_CONFIG.DRIFT_QUANTITY;
      const targetKmno = -targetSignal * TRADING_CONFIG.KMNO_QUANTITY;
      const actualDrift = exchangePosition?.drift || 0;
      const actualKmno = exchangePosition?.kmno || 0;

      const driftDiff = Math.abs(actualDrift - targetDrift);
      const kmnoDiff = Math.abs(actualKmno - targetKmno);

      if (driftDiff <= 0.1 && kmnoDiff <= 0.1) {
        this.position = exchangePosition;
        return;
      }

      log.position("Position reconciliation needed", {
        should: { drift: targetDrift, kmno: targetKmno },
        actual: { drift: actualDrift, kmno: actualKmno },
        corrections: { drift: driftDiff, kmno: kmnoDiff },
      });

      // Correct DRIFT position if needed
      if (driftDiff > 0.1) {
        let direction: PositionDirection;
        if (actualDrift > targetDrift) {
          // Too much DRIFT, need to sell/short
          direction = PositionDirection.SHORT;
        } else {
          // Too little DRIFT, need to buy/long
          direction = PositionDirection.LONG;
        }
        await placeOrder("DRIFT", direction, driftDiff, true);
      }

      // Correct KMNO position if needed
      if (kmnoDiff > 0.1) {
        let direction: PositionDirection;
        if (actualKmno > targetKmno) {
          // Too much KMNO, need to sell/short
          direction = PositionDirection.SHORT;
        } else {
          // Too little KMNO, need to buy/long
          direction = PositionDirection.LONG;
        }
        await placeOrder("KMNO", direction, kmnoDiff, true);
      }

      this.position = {
        drift: targetDrift,
        kmno: targetKmno,
        signal: targetSignal,
      };

      log.position("Position correction completed");
    } catch (error) {
      log.error("RECONCILE", "Position reconciliation failed", error as Error);
      this.state = BotState.EMERGENCY;
    }
  }
  // Log current state
  private async logCurrentState(): Promise<void> {
    // Log position
    if (this.position) {
      log.position("Current position", this.position);
    }

    // Log account state
    const accountResult = await getAccountState();
    if (accountResult.success) {
      log.position("Account state", accountResult.data);
    }
  }

  // Helper to convert signal to string
  private getSignalString(signal: Signal): string {
    return signal === 1 ? "LONG" : signal === -1 ? "SHORT" : "FLAT";
  }

  // Get bot status
  getStatus() {
    return {
      state: this.state,
      position: this.position,
      cycleCount: this.cycleCount,
      isRunning: this.isCycleRunning,
    };
  }
}
