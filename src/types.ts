export type CandleData = {
	ts: number;
	fillHigh: number;
	fillOpen: number;
	fillClose: number;
	fillLow: number;
	oracleOpen: number;
	oracleHigh: number;
	oracleClose: number;
	oracleLow: number;
	quoteVolume: number;
	baseVolume: number;
};

export type Signal = -1 | 0 | 1;

export type LiquidityCheck = {
	canFill: boolean;
	estimatedSlippage: number;
};

export type PerformanceSnapshot = {
	timestamp: number;
	cycle: number;
	accountEquity: number;
	accountUnrealizedPnl: number;
	strategyEquity: number;
	strategyRealizedPnl: number;
	spread: {
		driftPrice: number;
		kmnoPrice: number;
		spreadValue: number;
	};
	positions: {
		drift: number;
		kmno: number;
	};
};

export type SpreadPosition = {
	drift: number;
	kmno: number;
	signal: Signal;
};
