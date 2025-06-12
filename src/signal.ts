import type { CandleData, Signal } from './types';
import { TRADING_CONFIG } from './config';

async function fetchCandles(symbol: string): Promise<CandleData[]> {
	const response = await fetch(
		`https://data.api.drift.trade/market/${symbol}/candles/15?limit=${
			TRADING_CONFIG.SIGNAL_LAG_PERIODS + 1
		}`
	);
	const data = (await response.json()) as any;
	return data.records;
}

function calculateSpread(driftPrice: number, kmnoPrice: number): number {
	return driftPrice - TRADING_CONFIG.PRICE_RATIO * kmnoPrice;
}

function generateSignal(spread: number): Signal {
	if (spread < 0) return 1; // Long DRIFT, Short KMNO
	if (spread > 0) return -1; // Short DRIFT, Long KMNO
	return 0; // Flat
}

export async function getSpreadSignal(): Promise<{
	signal: Signal;
	spread: number;
	driftPrice: number;
	kmnoPrice: number;
}> {
	const [driftCandles, kmnoCandles] = await Promise.all([
		fetchCandles('DRIFT-PERP'),
		fetchCandles('KMNO-PERP'),
	]);

	const lagIndex = TRADING_CONFIG.SIGNAL_LAG_PERIODS;
	const driftPrice = driftCandles[lagIndex]!.oracleClose;
	const kmnoPrice = kmnoCandles[lagIndex]!.oracleClose;

	const spread = calculateSpread(driftPrice, kmnoPrice);
	const signal = generateSignal(spread);

	return { signal, spread, driftPrice, kmnoPrice };
}
