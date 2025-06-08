import { TradingBot } from "./bot";
import { log } from "./logger";

// Global bot instance
let bot: TradingBot | null = null;
let isShuttingDown = false;

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    log.cycle(0, "Shutdown already in progress, ignoring signal", { signal });
    return;
  }

  isShuttingDown = true;
  log.cycle(0, "Graceful shutdown initiated", { signal });

  try {
    if (bot) {
      await bot.stop();
    }

    log.cycle(0, "Shutdown completed successfully");
    process.exit(0);
  } catch (error) {
    log.error("SHUTDOWN", "Error during shutdown", error as Error);
    process.exit(1);
  }
}

// Setup signal handlers
function setupSignalHandlers(): void {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    log.error("FATAL", "Uncaught exception", error);
    shutdown("UNCAUGHT_EXCEPTION");
  });

  // Handle unhandled rejections
  process.on("unhandledRejection", (reason, promise) => {
    log.error(
      "FATAL",
      "Unhandled promise rejection",
      new Error(String(reason))
    );
    shutdown("UNHANDLED_REJECTION");
  });
}

// Main function
async function main(): Promise<void> {
  try {
    log.cycle(0, "Trading bot starting up");

    // Setup signal handlers
    setupSignalHandlers();

    // Create and initialize bot
    bot = new TradingBot();

    const initResult = await bot.initialize();
    if (!initResult.success) {
      log.error(
        "MAIN",
        "Bot initialization failed",
        new Error(initResult.error)
      );
      process.exit(1);
    }

    // Start trading
    bot.start();

    log.cycle(0, "Trading bot is now running");

    // Keep process alive and log status periodically
    setInterval(() => {
      const status = bot?.getStatus();
      if (status) {
        log.cycle(0, "Bot status", {
          state: status.state,
          cycleCount: status.cycleCount,
          hasPosition: !!status.position,
          isRunning: status.isRunning,
        });
      }
    }, 60000); // Log status every minute
  } catch (error) {
    log.error("MAIN", "Fatal error in main", error as Error);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  log.error("MAIN", "Unhandled error in main", error as Error);
  process.exit(1);
});
