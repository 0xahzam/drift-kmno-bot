import {
  DriftClient,
  Wallet,
  initialize,
  BulkAccountLoader,
  PerpMarkets,
  OrderType,
  PositionDirection,
  BASE_PRECISION,
  QUOTE_PRECISION,
  BN,
} from "@drift-labs/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, config, TRADING_CONFIG, RISK_CONFIG } from "./config";
import type {
  Position,
  CandleData,
  LiquidityCheck,
  AccountState,
  Result,
  Signal,
} from "./types";
import { log } from "./logger";

// Global state
let driftClient: DriftClient;
let marketMap: Map<string, any>;

// Initialize Drift client
export async function initializeDrift(): Promise<Result<void>> {
  try {
    log.cycle(0, "Initializing Drift client");

    const sdk = initialize({ env: TRADING_CONFIG.ENV });
    const accountLoader = new BulkAccountLoader(connection, "confirmed", 1000);

    // Parse private key
    let secretKey: Uint8Array;
    try {
      secretKey = config.PRIVATE_KEY.startsWith("[")
        ? new Uint8Array(JSON.parse(config.PRIVATE_KEY))
        : Buffer.from(config.PRIVATE_KEY, "base64");
    } catch (error) {
      return {
        success: false,
        error: `Failed to parse private key: ${(error as Error).message}`,
      };
    }

    const wallet = new Wallet(Keypair.fromSecretKey(secretKey));
    log.cycle(0, "Wallet loaded", { address: wallet.publicKey.toString() });

    driftClient = new DriftClient({
      connection,
      wallet,
      programID: new PublicKey(sdk.DRIFT_PROGRAM_ID),
      accountSubscription: {
        type: "websocket",
        //@ts-ignore
        accountLoader,
      },
    });

    await driftClient.subscribe();
    const user = driftClient.getUser();
    await user.exists();

    // Load market configs
    marketMap = new Map(
      PerpMarkets[TRADING_CONFIG.ENV].map((market) => [
        market.baseAssetSymbol,
        market,
      ])
    );

    // Validate required markets exist
    const driftMarket = marketMap.get("DRIFT");
    const kmnoMarket = marketMap.get("KMNO");
    if (!driftMarket || !kmnoMarket) {
      return {
        success: false,
        error: "Required markets DRIFT or KMNO not found",
      };
    }

    log.cycle(0, "Drift client initialized", {
      driftIndex: driftMarket.marketIndex,
      kmnoIndex: kmnoMarket.marketIndex,
    });

    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: `Drift initialization failed: ${(error as Error).message}`,
    };
  }
}

// Fetch market data with retry
export async function fetchMarketData(): Promise<
  Result<{
    driftCandles: CandleData[];
    kmnoCandles: CandleData[];
  }>
> {
  const fetchWithRetry = async (symbol: string): Promise<CandleData[]> => {
    for (let attempt = 1; attempt <= RISK_CONFIG.MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(
          `https://data.api.drift.trade/market/${symbol}/candles/15?limit=${
            TRADING_CONFIG.SIGNAL_LAG_PERIODS + 1
          }`
        );
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = (await response.json()) as any;
        return data.records;
      } catch (error) {
        if (attempt === RISK_CONFIG.MAX_RETRIES) throw error;
        const delay = RISK_CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        log.error(
          "MARKET",
          `Fetch attempt ${attempt} failed, retrying in ${delay}ms`,
          error as Error
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Retry logic failed unexpectedly");
  };

  try {
    const [driftCandles, kmnoCandles] = await Promise.all([
      fetchWithRetry("DRIFT-PERP"),
      fetchWithRetry("KMNO-PERP"),
    ]);

    return {
      success: true,
      data: { driftCandles, kmnoCandles },
    };
  } catch (error) {
    return {
      success: false,
      error: `Market data fetch failed: ${(error as Error).message}`,
    };
  }
}

// Check liquidity depth
export async function checkLiquidity(
  marketSymbol: string,
  side: "bids" | "asks",
  orderSize: number
): Promise<LiquidityCheck> {
  try {
    const response = await fetch(
      `https://dlob.drift.trade/l2?marketName=${marketSymbol}`
    );
    if (!response.ok) throw new Error(`DLOB API error: ${response.status}`);

    const data = (await response.json()) as any;
    const orders = data[side];

    if (!orders || orders.length === 0) {
      return { canFill: false, estimatedSlippage: Infinity };
    }

    let totalSize = 0;
    let totalValue = 0;
    const bestPrice = parseFloat(orders[0].price) / QUOTE_PRECISION.toNumber();

    for (const order of orders) {
      const levelPrice = parseFloat(order.price) / QUOTE_PRECISION.toNumber();
      const levelSize = parseFloat(order.size) / BASE_PRECISION.toNumber();

      const fillSize = Math.min(levelSize, orderSize - totalSize);
      totalValue += fillSize * levelPrice;
      totalSize += fillSize;

      if (totalSize >= orderSize) break;
    }

    if (totalSize < orderSize) {
      return { canFill: false, estimatedSlippage: Infinity };
    }

    const avgPrice = totalValue / totalSize;
    const slippage = Math.abs((avgPrice - bestPrice) / bestPrice);

    return { canFill: true, estimatedSlippage: slippage };
  } catch (error) {
    log.error(
      "LIQUIDITY",
      `Failed to check ${marketSymbol} ${side}`,
      error as Error
    );
    return { canFill: false, estimatedSlippage: Infinity };
  }
}

// Place order
export async function placeOrder(
  market: string,
  direction: PositionDirection,
  quantity: number,
  reduceOnly: boolean = false
): Promise<Result<string>> {
  if (TRADING_CONFIG.SIMULATION_MODE) {
    const action = reduceOnly ? "CLOSE" : "OPEN";
    const directionStr =
      direction === PositionDirection.LONG ? "LONG" : "SHORT";
    log.order(action, market, `Simulated order: ${directionStr} ${quantity}`, {
      simulation: true,
    });
    return { success: true, data: "simulation-tx" };
  }

  try {
    const marketConfig = marketMap.get(market);
    if (!marketConfig) {
      return { success: false, error: `Market config not found for ${market}` };
    }

    const tx = await driftClient.placePerpOrder({
      orderType: OrderType.MARKET,
      marketIndex: marketConfig.marketIndex,
      direction,
      baseAssetAmount: new BN(quantity).mul(BASE_PRECISION),
      reduceOnly,
    });

    const action = reduceOnly ? "CLOSE" : "OPEN";
    const directionStr =
      direction === PositionDirection.LONG ? "LONG" : "SHORT";
    log.order(action, market, `Order placed: ${directionStr} ${quantity}`, {
      txSignature: tx,
      marketIndex: marketConfig.marketIndex,
    });

    return { success: true, data: tx };
  } catch (error) {
    return {
      success: false,
      error: `Order placement failed: ${(error as Error).message}`,
    };
  }
}

// Get current positions from exchange
export async function getCurrentPositions(): Promise<Result<Position | null>> {
  if (TRADING_CONFIG.SIMULATION_MODE) {
    return { success: true, data: null };
  }

  try {
    const positions = driftClient.getUser().getUserAccount().perpPositions;
    let drift = 0;
    let kmno = 0;

    for (const pos of positions) {
      if (pos.baseAssetAmount.eq(new BN(0))) continue;

      const market = Array.from(marketMap.values()).find(
        (m) => m.marketIndex === pos.marketIndex
      );
      if (!market) continue;

      const size = pos.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber();

      if (market.baseAssetSymbol === "DRIFT") {
        drift = size;
      }
      if (market.baseAssetSymbol === "KMNO") {
        kmno = size;
      }
    }

    if (drift === 0 && kmno === 0) {
      return { success: true, data: null };
    }

    // Determine signal from positions
    let signal: Signal = 0;
    if (drift > 0 && kmno < 0) signal = 1;
    else if (drift < 0 && kmno > 0) signal = -1;

    return {
      success: true,
      data: { drift, kmno, signal },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get positions: ${(error as Error).message}`,
    };
  }
}

// Get account state
export async function getAccountState(): Promise<Result<AccountState>> {
  if (TRADING_CONFIG.SIMULATION_MODE) {
    return {
      success: true,
      data: {
        totalCollateral: 1000,
        freeCollateral: 800,
        unrealizedPnL: 0,
      },
    };
  }

  try {
    const user = driftClient.getUser();
    const [totalCollateral, freeCollateral, unrealizedPnL] = [
      user.getTotalCollateral(),
      user.getFreeCollateral(),
      user.getUnrealizedPNL(),
    ].map((n) => Number(n) / Number(QUOTE_PRECISION));

    if (!totalCollateral || !freeCollateral || !unrealizedPnL)
      throw new Error();

    return {
      success: true,
      data: { totalCollateral, freeCollateral, unrealizedPnL },
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to get account state: ${(error as Error).message}`,
    };
  }
}

// Cleanup
export async function cleanup(): Promise<void> {
  try {
    if (driftClient) {
      await driftClient.unsubscribe();
      log.cycle(0, "Drift client disconnected");
    }
  } catch (error) {
    log.error("CLEANUP", "Failed to cleanup Drift client", error as Error);
  }
}
