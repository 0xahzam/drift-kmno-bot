# DRIFT-KMNO Spread Bot

Automated spread trading bot for DRIFT/KMNO perpetuals on Drift Protocol.

## Strategy

Market-neutral spread trading:
- **LONG**: Buy DRIFT (10) + Sell KMNO (100)
- **SHORT**: Sell DRIFT (10) + Buy KMNO (100)
- **FLAT**: No positions

Signal based on convergence/divergence behaviour showed by the pair and validated with backtest.

## Setup

```bash
bun i
cp .env.example .env
# Set PRIVATE_KEY and RPC
bun start
```

**Required env vars:**
- `PRIVATE_KEY`: Solana wallet (base64 or JSON array)
- `RPC_URL`: Solana RPC endpoint

## Configuration

Edit `config.ts`:

```typescript
TRADING_CONFIG = {
  DRIFT_QUANTITY: 100,        // Fixed position size
  KMNO_QUANTITY: 1000,
  CYCLE_INTERVAL_MS: 60000,   // 1 minute
  SIGNAL_LAG_PERIODS: 3,      // Signal confirmation
  SIMULATION_MODE: false      // Paper trading
}

RISK_CONFIG = {
  MAX_SLIPPAGE_BPS: 25,       // 0.25% open
  CLOSE_MAX_SLIPPAGE_BPS: 50, // 0.50% close
}
```

## Architecture

```
signal.ts     # Pure signal calculations
risk.ts       # Slippage/liquidity validation
drift.ts      # Drift protocol integration
bot.ts        # State machine + position management
main.ts       # Entry point
```

## Position Management

**Reconciliation (every 10 cycles):**
- Compares internal vs exchange positions
- Auto-corrects size drift (e.g., 2x position → reduces by half)
- Closes unexpected positions
- Recreates missing positions

**States:**
- `HEALTHY`: Normal operation
- `DEGRADED`: Minor issues, continue trading
- `EMERGENCY`: Critical error, close all positions

## Monitoring

**Key logs:**
```bash
# Errors
grep '"level":"error"' bot.log

# Position changes
grep '"category":"POSITION"' bot.log

# Cycle performance
grep '"duration"' bot.log
```

**Graceful shutdown:**
```bash
kill -TERM <pid>  # Closes positions before exit
```

## Risk Controls

- Fixed position sizes (no sizing algorithms)
- Slippage validation before orders
- Position reconciliation prevents drift
- Emergency state on critical errors
- Market orders only (no complex order types)

## Production Notes

- Bot auto-recovers from most errors
- Position reconciliation handles exchange glitches
- All functions return explicit `Result<T>` types
- Structured JSON logging with correlation IDs
- Set `SIMULATION_MODE=true` for testing
