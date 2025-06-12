# DRIFT-KMNO Spread Bot

Automated spread trading bot for DRIFT/KMNO perpetuals on Drift Protocol.

## Strategy

Market-neutral spread trading based on price ratio deviations:

- **LONG**: Buy DRIFT (10) + Sell KMNO (100) when spread < 0
- **SHORT**: Sell DRIFT (10) + Buy KMNO (100) when spread > 0
- **FLAT**: No positions when spread = 0

Signal: `drift_price - (10 * kmno_price)` with 2-period lag for stability.

## Setup

```bash
bun i
cp .env.example .env
# Set PRIVATE_KEY, RPC_ENDPOINT, RPC_WS, AUTHORITY_KEY
bun start
```

## Configuration

Edit `config.ts`:

```typescript
TRADING_CONFIG = {
	DRIFT_QUANTITY: 10, // DRIFT position size
	KMNO_QUANTITY: 100, // KMNO position size
	PRICE_RATIO: 10, // Spread multiplier
	CYCLE_INTERVAL_MS: 6300000, // 105 minutes
	SIGNAL_LAG_PERIODS: 2, // Signal confirmation
};

RISK_CONFIG = {
	MAX_SLIPPAGE_BPS: 25, // 0.25% open
	CLOSE_MAX_SLIPPAGE_BPS: 50, // 0.50% close
};
```

## Architecture

```
signal.ts    # Real-time spread calculation
bot.ts       # Dual-leg position management
types.ts     # Clean type definitions
logger.ts    # Performance snapshots
main.ts      # Graceful shutdown
config.ts    # Trading parameters
```

## Features

- **Real-time signals**: Fresh spread data every cycle
- **Dual-leg execution**: Sequential DRIFT + KMNO orders
- **Position reconciliation**: Auto-corrects position drift
- **PnL tracking**: Strategy-specific performance
- **Liquidity validation**: Both legs checked before execution
- **Emergency handling**: Auto-close on critical errors

## Monitoring

**Key logs:**

```bash
grep "Signal retrieved" bot.log     # Spread signals
grep "realized PnL" bot.log         # Position closes
grep "EMERGENCY" bot.log            # Critical errors
```

**Performance tracking:**

- Account equity vs strategy equity
- Realized PnL per position close
- Slippage on both legs

## Risk Controls

- Fixed position sizes (10 DRIFT, 100 KMNO)
- Pre-trade liquidity validation
- Position reconciliation prevents drift
- Market orders with retry logic
- Graceful shutdown closes positions
