import { Connection } from '@solana/web3.js';
import { log } from './logger';

const RPC_HTTP = Bun.env.RPC_ENDPOINT;
const RPC_WS = Bun.env.RPC_WS;
const PRIVATE_KEY = Bun.env.PRIVATE_KEY;
const AUTHORITY_KEY = Bun.env.AUTHORITY_KEY;

if (!RPC_HTTP || !RPC_WS) {
	log.error(
		'CONFIG',
		'Missing RPC endpoints',
		new Error('Environment variables not set')
	);
	process.exit(1);
}

if (!PRIVATE_KEY || !AUTHORITY_KEY) {
	log.error(
		'CONFIG',
		'Missing PRIVATE_KEY in environment',
		new Error('PRIVATE_KEY not found')
	);
	process.exit(1);
}

export const TRADING_CONFIG = {
	DRIFT_QUANTITY: 10,
	KMNO_QUANTITY: 100,
	PRICE_RATIO: 10,
	SIGNAL_LAG_PERIODS: 2,
	CYCLE_INTERVAL_MS: 7 * 900_000, // 7 * 15min
	SIMULATION_MODE: false,
	ENV: 'mainnet-beta' as const,
};

export const RISK_CONFIG = {
	MAX_SLIPPAGE_BPS: 25,
	CLOSE_MAX_SLIPPAGE_BPS: 50,
	MAX_RETRIES: 3,
	RETRY_DELAY_MS: 1000,
};

export const config = {
	RPC_HTTP,
	RPC_WS,
	PRIVATE_KEY,
	AUTHORITY_KEY,
};

export const connection = new Connection(RPC_HTTP, {
	wsEndpoint: RPC_WS,
	commitment: 'confirmed',
});
