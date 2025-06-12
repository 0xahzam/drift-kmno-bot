import { getSpreadSignal } from './signal';
import type {
	Signal,
	LiquidityCheck,
	PerformanceSnapshot,
	SpreadPosition,
} from './types';
import { log } from './logger';
import { TRADING_CONFIG, RISK_CONFIG, config } from './config';
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
	type PerpMarketAccount,
} from '@drift-labs/sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { Connection } from '@solana/web3.js';

let driftClient: DriftClient;
let driftMarketIndex: number;
let kmnoMarketIndex: number;

// Cache frequently used values
const BASE_PRECISION_NUM = BASE_PRECISION.toNumber();
const QUOTE_PRECISION_NUM = QUOTE_PRECISION.toNumber();
const DRIFT_QUANTITY_SCALED =
	TRADING_CONFIG.DRIFT_QUANTITY * BASE_PRECISION_NUM;
const KMNO_QUANTITY_SCALED = TRADING_CONFIG.KMNO_QUANTITY * BASE_PRECISION_NUM;
const MAX_SLIPPAGE_DECIMAL = RISK_CONFIG.MAX_SLIPPAGE_BPS / 10000;
const CLOSE_MAX_SLIPPAGE_DECIMAL = RISK_CONFIG.CLOSE_MAX_SLIPPAGE_BPS / 10000;

// Pre-computed signal strings
const SIGNAL_STRINGS = ['SHORT', 'FLAT', 'LONG'] as const;
const getSignalString = (signal: Signal): string => SIGNAL_STRINGS[signal + 1]!;

enum BotState {
	INITIALIZING = 'INITIALIZING',
	HEALTHY = 'HEALTHY',
	EMERGENCY = 'EMERGENCY',
	SHUTDOWN = 'SHUTDOWN',
}

export class SpreadBot {
	private state: BotState = BotState.INITIALIZING;
	private currentPosition: SpreadPosition | null = null;
	private cycleCount = 0;
	private isCycleRunning = false;
	private cycleInterval: NodeJS.Timeout | null = null;

	private strategyStartingEquity: number = 0;
	private strategyRealizedPnl: number = 0;

	async initialize(): Promise<{ success: boolean; error?: string }> {
		try {
			log.cycle(0, 'Spread bot initialization started');

			const driftInit = await this.initializeDrift();
			if (!driftInit.success) return driftInit;

			log.cycle(0, 'Configuration loaded', {
				driftQuantity: TRADING_CONFIG.DRIFT_QUANTITY,
				kmnoQuantity: TRADING_CONFIG.KMNO_QUANTITY,
				priceRatio: TRADING_CONFIG.PRICE_RATIO,
				cycleInterval: `${TRADING_CONFIG.CYCLE_INTERVAL_MS / 1000}s`,
				env: TRADING_CONFIG.ENV,
			});

			const user = driftClient.getUser();
			this.strategyStartingEquity =
				user.getTotalCollateral().toNumber() / QUOTE_PRECISION_NUM;

			log.cycle(0, 'Strategy tracking initialized', {
				startingEquity: this.strategyStartingEquity,
			});

			this.reconstructPosition();

			this.state = BotState.HEALTHY;
			log.cycle(0, 'Spread bot initialized successfully', {
				state: this.state,
			});

			return { success: true };
		} catch (error) {
			this.state = BotState.EMERGENCY;
			return {
				success: false,
				error: `Bot initialization failed: ${(error as Error).message}`,
			};
		}
	}

	private async initializeDrift(): Promise<{
		success: boolean;
		error?: string;
	}> {
		try {
			log.cycle(0, 'Initializing Drift client');

			const connection = new Connection(config.RPC_HTTP, {
				wsEndpoint: config.RPC_WS,
				commitment: 'confirmed',
			});

			const sdk = initialize({ env: TRADING_CONFIG.ENV });
			const accountLoader = new BulkAccountLoader(
				connection,
				'confirmed',
				1000
			);

			let secretKey: Uint8Array;
			try {
				secretKey = config.PRIVATE_KEY.startsWith('[')
					? new Uint8Array(JSON.parse(config.PRIVATE_KEY))
					: Buffer.from(config.PRIVATE_KEY, 'base64');
			} catch (error) {
				return {
					success: false,
					error: `Failed to parse private key: ${(error as Error).message}`,
				};
			}

			const wallet = new Wallet(Keypair.fromSecretKey(secretKey));
			log.cycle(0, 'Wallet loaded', { address: wallet.publicKey.toString() });

			driftClient = new DriftClient({
				connection,
				wallet,
				programID: new PublicKey(sdk.DRIFT_PROGRAM_ID),
				authority: new PublicKey(config.AUTHORITY_KEY),
				subAccountIds: [5],
				activeSubAccountId: 5,
				accountSubscription: {
					type: 'websocket',
					//@ts-ignore
					accountLoader,
				},
			});

			await driftClient.subscribe();
			const user = driftClient.getUser();
			await user.exists();

			const driftMarket = PerpMarkets[TRADING_CONFIG.ENV].find(
				(market) => market.baseAssetSymbol === 'DRIFT'
			);
			const kmnoMarket = PerpMarkets[TRADING_CONFIG.ENV].find(
				(market) => market.baseAssetSymbol === 'KMNO'
			);

			if (!driftMarket || !kmnoMarket) {
				return {
					success: false,
					error: 'DRIFT or KMNO market not found',
				};
			}

			driftMarketIndex = driftMarket.marketIndex;
			kmnoMarketIndex = kmnoMarket.marketIndex;

			log.cycle(0, 'Drift client initialized', {
				driftMarketIndex,
				kmnoMarketIndex,
			});
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: `Drift initialization failed: ${(error as Error).message}`,
			};
		}
	}

	private getCurrentSpreadPosition(): SpreadPosition | null {
		try {
			const positions = driftClient.getUser().getUserAccount().perpPositions;
			let drift = 0;
			let kmno = 0;

			for (const pos of positions) {
				if (pos.baseAssetAmount.eq(new BN(0))) continue;

				const size = pos.baseAssetAmount.toNumber() / BASE_PRECISION_NUM;

				if (pos.marketIndex === driftMarketIndex) {
					drift = size;
				}
				if (pos.marketIndex === kmnoMarketIndex) {
					kmno = size;
				}
			}

			if (drift === 0 && kmno === 0) {
				return null;
			}

			// Determine signal from positions
			let signal: Signal = 0;
			if (drift > 0 && kmno < 0) signal = 1; // Long DRIFT, Short KMNO
			else if (drift < 0 && kmno > 0) signal = -1; // Short DRIFT, Long KMNO

			return { drift, kmno, signal };
		} catch (error) {
			log.error('POSITION', 'Failed to get current positions', error as Error);
			return null;
		}
	}

	private async checkLiquidity(
		marketSymbol: string,
		side: 'bids' | 'asks',
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
			const bestPrice = +orders[0].price / QUOTE_PRECISION_NUM;

			for (let i = 0; i < orders.length; i++) {
				const order = orders[i];
				const levelPrice = +order.price / QUOTE_PRECISION_NUM;
				const levelSize = +order.size / BASE_PRECISION_NUM;

				const remaining = orderSize - totalSize;
				if (remaining <= 0) break;

				const fillSize = levelSize < remaining ? levelSize : remaining;
				totalValue += fillSize * levelPrice;
				totalSize += fillSize;

				if (totalSize >= orderSize) break;
			}

			if (totalSize < orderSize) {
				return { canFill: false, estimatedSlippage: Infinity };
			}

			const avgPrice = totalValue / totalSize;
			const slippage =
				avgPrice > bestPrice
					? (avgPrice - bestPrice) / bestPrice
					: (bestPrice - avgPrice) / bestPrice;

			return { canFill: true, estimatedSlippage: slippage };
		} catch (error) {
			log.error(
				'LIQUIDITY',
				`Failed to check ${marketSymbol} ${side}`,
				error as Error
			);
			return { canFill: false, estimatedSlippage: Infinity };
		}
	}

	private validateLiquidity(
		liquidityCheck: LiquidityCheck,
		marketSymbol: string,
		isClosing: boolean = false
	): { success: boolean; error?: string; slippagePercent: number } {
		if (!liquidityCheck.canFill) {
			return {
				success: false,
				error: `${marketSymbol}: Insufficient market liquidity`,
				slippagePercent: 0,
			};
		}

		const maxSlippage = isClosing
			? CLOSE_MAX_SLIPPAGE_DECIMAL
			: MAX_SLIPPAGE_DECIMAL;
		const slippagePercent = liquidityCheck.estimatedSlippage * 100;

		if (liquidityCheck.estimatedSlippage > maxSlippage) {
			return {
				success: false,
				error: `${marketSymbol}: Slippage too high: ${slippagePercent.toFixed(
					3
				)}% > ${(maxSlippage * 100).toFixed(3)}%`,
				slippagePercent,
			};
		}
		return { success: true, slippagePercent };
	}

	private reconstructPosition(): void {
		const position = this.getCurrentSpreadPosition();
		this.currentPosition = position;

		if (position) {
			log.cycle(0, 'Reconstructed spread position', {
				signal: getSignalString(position.signal),
				drift: position.drift,
				kmno: position.kmno,
			});
		} else {
			log.cycle(0, 'No existing spread position found');
		}
	}

	start(): void {
		if (this.state !== BotState.HEALTHY) {
			log.error(
				'BOT',
				'Cannot start bot in non-healthy state',
				new Error(`Current state: ${this.state}`)
			);
			return;
		}

		log.cycle(0, 'Starting spread trading');
		this.executeCycle();
		this.cycleInterval = setInterval(
			() => this.executeCycle(),
			TRADING_CONFIG.CYCLE_INTERVAL_MS
		);
	}

	async stop(): Promise<void> {
		log.cycle(0, 'Stopping bot');

		if (this.cycleInterval) {
			clearInterval(this.cycleInterval);
			this.cycleInterval = null;
		}

		while (this.isCycleRunning) {
			log.cycle(0, 'Waiting for current cycle to complete');
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		if (this.currentPosition) {
			log.cycle(0, 'Closing positions before shutdown');
			await this.closePosition();
		}

		if (driftClient) {
			await driftClient.unsubscribe();
			log.cycle(0, 'Drift client disconnected');
		}

		log.cycle(0, 'Bot stopped', { totalCycles: this.cycleCount });
	}

	private async executeCycle(): Promise<void> {
		if (this.isCycleRunning) {
			log.cycle(this.cycleCount + 1, 'Previous cycle still running, skipping');
			return;
		}

		this.isCycleRunning = true;
		this.cycleCount++;
		const cycleStart = process.hrtime.bigint();

		try {
			log.cycle(this.cycleCount, 'Cycle started');

			if (this.state === BotState.EMERGENCY) {
				log.cycle(this.cycleCount, 'Bot in emergency state, closing positions');
				await this.closePosition();
				return;
			}

			const signalData = await getSpreadSignal();
			const currentSignal = this.currentPosition?.signal || 0;
			const currentStr = getSignalString(currentSignal);
			const signalStr = getSignalString(signalData.signal);

			log.cycle(this.cycleCount, 'Signal retrieved', {
				signal: signalStr,
				currentPosition: currentStr,
				spread: signalData.spread.toFixed(4),
				driftPrice: signalData.driftPrice.toFixed(4),
				kmnoPrice: signalData.kmnoPrice.toFixed(4),
			});

			if (signalData.signal !== currentSignal) {
				await this.changePosition(signalData.signal, currentStr, signalStr);
			} else {
				log.cycle(this.cycleCount, 'Holding current position', {
					position: currentStr,
				});

				// Only reconcile when we're NOT making position changes
				await this.reconcilePosition();
			}

			this.state = BotState.HEALTHY;
		} catch (error) {
			log.error('CYCLE', `Cycle ${this.cycleCount} failed`, error as Error);
			this.state = BotState.EMERGENCY;
		} finally {
			const snapshot = await this.capturePerformanceSnapshot();
			if (snapshot) {
				log.snapshot(snapshot);
			}
			const cycleTime = Number(process.hrtime.bigint() - cycleStart) / 1e6;
			log.cycle(this.cycleCount, 'Cycle completed', {
				duration: `${cycleTime.toFixed(1)}ms`,
			});
			this.isCycleRunning = false;
		}
	}

	private async changePosition(
		newSignal: Signal,
		currentStr: string,
		newStr: string
	): Promise<void> {
		log.cycle(
			this.cycleCount,
			`Position transition: ${currentStr} -> ${newStr}`
		);

		try {
			if (this.currentPosition) {
				await this.closePosition();
			}

			if (newSignal !== 0) {
				await this.openPosition(newSignal);
			}

			log.position(`Position successfully changed to ${newStr}`);
		} catch (error) {
			log.error('TRANSITION', 'Position transition failed', error as Error);
			this.state = BotState.EMERGENCY;
			throw error;
		}
	}

	private async executeOrder(
		marketIndex: number,
		direction: PositionDirection,
		baseAssetAmount: BN,
		reduceOnly: boolean,
		orderType: string
	): Promise<string> {
		// Market order with retries
		for (let attempt = 1; attempt <= RISK_CONFIG.MAX_RETRIES; attempt++) {
			try {
				const tx = await driftClient.placePerpOrder({
					orderType: OrderType.MARKET,
					marketIndex,
					direction,
					baseAssetAmount,
					reduceOnly,
				});
				return tx;
			} catch (error) {
				if (attempt === RISK_CONFIG.MAX_RETRIES) {
					throw new Error(
						`${orderType} order failed after ${attempt} attempts: ${
							(error as Error).message
						}`
					);
				}

				const delay = RISK_CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1);
				log.error(
					'ORDER',
					`${orderType} attempt ${attempt} failed, retrying in ${delay}ms`,
					error as Error
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		throw new Error('Should not reach here');
	}

	private async openPosition(signal: Signal): Promise<void> {
		const signalStr = getSignalString(signal);
		log.position(`Opening ${signalStr} spread`, {
			driftQuantity: TRADING_CONFIG.DRIFT_QUANTITY,
			kmnoQuantity: TRADING_CONFIG.KMNO_QUANTITY,
		});

		const driftDirection =
			signal > 0 ? PositionDirection.LONG : PositionDirection.SHORT;
		const kmnoDirection =
			signal > 0 ? PositionDirection.SHORT : PositionDirection.LONG;
		const driftSide =
			driftDirection === PositionDirection.LONG ? 'asks' : 'bids';
		const kmnoSide = kmnoDirection === PositionDirection.LONG ? 'asks' : 'bids';

		// Check liquidity for both legs
		const [driftLiquidity, kmnoLiquidity] = await Promise.all([
			this.checkLiquidity(
				'DRIFT-PERP',
				driftSide,
				TRADING_CONFIG.DRIFT_QUANTITY
			),
			this.checkLiquidity('KMNO-PERP', kmnoSide, TRADING_CONFIG.KMNO_QUANTITY),
		]);

		const driftValidation = this.validateLiquidity(
			driftLiquidity,
			'DRIFT',
			false
		);
		const kmnoValidation = this.validateLiquidity(kmnoLiquidity, 'KMNO', false);

		if (!driftValidation.success || !kmnoValidation.success) {
			const error = !driftValidation.success
				? driftValidation.error
				: kmnoValidation.error;
			log.error('POSITION', 'Liquidity validation failed', new Error(error));
			return;
		}

		log.position('Liquidity check passed', {
			driftSlippage: `${driftValidation.slippagePercent.toFixed(3)}%`,
			kmnoSlippage: `${kmnoValidation.slippagePercent.toFixed(3)}%`,
		});

		// Execute orders sequentially for better control
		const driftBaseAmount = new BN(DRIFT_QUANTITY_SCALED);
		const kmnoBaseAmount = new BN(KMNO_QUANTITY_SCALED);

		const driftTx = await this.executeOrder(
			driftMarketIndex,
			driftDirection,
			driftBaseAmount,
			false,
			'Open DRIFT'
		);

		const kmnoTx = await this.executeOrder(
			kmnoMarketIndex,
			kmnoDirection,
			kmnoBaseAmount,
			false,
			'Open KMNO'
		);

		// Update internal state
		this.currentPosition = {
			drift: signal * TRADING_CONFIG.DRIFT_QUANTITY,
			kmno: -signal * TRADING_CONFIG.KMNO_QUANTITY,
			signal,
		};

		log.order('OPEN', 'SPREAD', `${signalStr} spread opened`, {
			driftTx,
			kmnoTx,
			driftQuantity: TRADING_CONFIG.DRIFT_QUANTITY,
			kmnoQuantity: TRADING_CONFIG.KMNO_QUANTITY,
		});
	}
	private calculatePositionPnl(
		signal: Signal,
		size: number,
		entryPrice: number,
		currentPrice: number
	): number {
		const positionValue = size * currentPrice;
		const entryValue = size * entryPrice;
		return signal > 0 ? positionValue - entryValue : entryValue - positionValue;
	}

	private getDriftPositionEntryPrice(): number {
		const perpPosition = driftClient
			.getUser()
			.getPerpPosition(driftMarketIndex);
		if (!perpPosition || perpPosition.baseAssetAmount.eq(new BN(0))) return 0;

		return (
			((perpPosition.quoteEntryAmount.abs().toNumber() /
				perpPosition.baseAssetAmount.abs().toNumber()) *
				BASE_PRECISION_NUM) /
			QUOTE_PRECISION_NUM
		);
	}

	private getKmnoPositionEntryPrice(): number {
		const perpPosition = driftClient.getUser().getPerpPosition(kmnoMarketIndex);
		if (!perpPosition || perpPosition.baseAssetAmount.eq(new BN(0))) return 0;

		return (
			((perpPosition.quoteEntryAmount.abs().toNumber() /
				perpPosition.baseAssetAmount.abs().toNumber()) *
				BASE_PRECISION_NUM) /
			QUOTE_PRECISION_NUM
		);
	}

	private async closePosition(): Promise<void> {
		const position = this.getCurrentSpreadPosition();

		if (!position) {
			log.position('No position to close');
			this.currentPosition = null;
			return;
		}

		const driftEntryPrice = this.getDriftPositionEntryPrice();
		const kmnoEntryPrice = this.getKmnoPositionEntryPrice();
		const currentStr = getSignalString(position.signal);

		// Determine close directions
		const driftDirection =
			position.drift > 0 ? PositionDirection.SHORT : PositionDirection.LONG;
		const kmnoDirection =
			position.kmno > 0 ? PositionDirection.SHORT : PositionDirection.LONG;

		const driftSide =
			driftDirection === PositionDirection.LONG ? 'asks' : 'bids';
		const kmnoSide = kmnoDirection === PositionDirection.LONG ? 'asks' : 'bids';

		const driftSize = Math.abs(position.drift);
		const kmnoSize = Math.abs(position.kmno);

		log.position(`Closing ${currentStr} spread`, {
			driftSize,
			kmnoSize,
		});

		// Check liquidity for close
		const [driftLiquidity, kmnoLiquidity] = await Promise.all([
			this.checkLiquidity('DRIFT-PERP', driftSide, driftSize),
			this.checkLiquidity('KMNO-PERP', kmnoSide, kmnoSize),
		]);

		const driftValidation = this.validateLiquidity(
			driftLiquidity,
			'DRIFT',
			true
		);
		const kmnoValidation = this.validateLiquidity(kmnoLiquidity, 'KMNO', true);

		if (!driftValidation.success || !kmnoValidation.success) {
			log.risk('Close liquidity validation failed, forcing close anyway', {
				driftError: driftValidation.error,
				kmnoError: kmnoValidation.error,
			});
		} else {
			log.position('Close liquidity check passed', {
				driftSlippage: `${driftValidation.slippagePercent.toFixed(3)}%`,
				kmnoSlippage: `${kmnoValidation.slippagePercent.toFixed(3)}%`,
			});
		}

		// Execute close orders
		const driftBaseAmount = new BN(driftSize * BASE_PRECISION_NUM);
		const kmnoBaseAmount = new BN(kmnoSize * BASE_PRECISION_NUM);

		const driftTx = await this.executeOrder(
			driftMarketIndex,
			driftDirection,
			driftBaseAmount,
			true,
			'Close DRIFT'
		);

		const kmnoTx = await this.executeOrder(
			kmnoMarketIndex,
			kmnoDirection,
			kmnoBaseAmount,
			true,
			'Close KMNO'
		);

		// Get close prices after order execution
		const driftMarket = driftClient.getPerpMarketAccount(
			driftMarketIndex
		) as PerpMarketAccount;
		const kmnoMarket = driftClient.getPerpMarketAccount(
			kmnoMarketIndex
		) as PerpMarketAccount;

		const driftClosePrice =
			driftMarket.amm.lastMarkPriceTwap.toNumber() / QUOTE_PRECISION_NUM;
		const kmnoClosePrice =
			kmnoMarket.amm.lastMarkPriceTwap.toNumber() / QUOTE_PRECISION_NUM;

		// Calculate realized PnL after execution
		if (driftEntryPrice > 0 || kmnoEntryPrice > 0) {
			let totalRealizedPnl = 0;

			if (driftEntryPrice > 0) {
				const driftPnl = this.calculatePositionPnl(
					position.drift > 0 ? 1 : -1,
					driftSize,
					driftEntryPrice,
					driftClosePrice
				);
				totalRealizedPnl += driftPnl;
			}

			if (kmnoEntryPrice > 0) {
				const kmnoPnl = this.calculatePositionPnl(
					position.kmno > 0 ? 1 : -1,
					kmnoSize,
					kmnoEntryPrice,
					kmnoClosePrice
				);
				totalRealizedPnl += kmnoPnl;
			}

			this.strategyRealizedPnl += totalRealizedPnl;

			log.position('Spread position closed with realized PnL', {
				driftEntry: driftEntryPrice.toFixed(2),
				driftClose: driftClosePrice.toFixed(2),
				kmnoEntry: kmnoEntryPrice.toFixed(2),
				kmnoClose: kmnoClosePrice.toFixed(2),
				totalRealizedPnl: totalRealizedPnl.toFixed(6),
				totalStrategyPnl: this.strategyRealizedPnl.toFixed(6),
			});
		}

		log.order('CLOSE', 'SPREAD', `${currentStr} spread closed`, {
			driftTx,
			kmnoTx,
			driftQuantity: driftSize,
			kmnoQuantity: kmnoSize,
			driftSlippage: `${driftValidation.slippagePercent.toFixed(3)}%`,
			kmnoSlippage: `${kmnoValidation.slippagePercent.toFixed(3)}%`,
		});

		this.currentPosition = null;
	}

	private async capturePerformanceSnapshot(): Promise<PerformanceSnapshot | null> {
		try {
			const user = driftClient.getUser();

			const accountEquity =
				user.getTotalCollateral().toNumber() / QUOTE_PRECISION_NUM;
			const accountUnrealizedPnl =
				user.getUnrealizedPNL().toNumber() / QUOTE_PRECISION_NUM;

			const strategyEquity =
				this.strategyStartingEquity + this.strategyRealizedPnl;

			// Get current spread data
			const signalData = await getSpreadSignal();

			return {
				timestamp: Date.now(),
				cycle: this.cycleCount,
				accountEquity,
				accountUnrealizedPnl,
				strategyEquity,
				strategyRealizedPnl: this.strategyRealizedPnl,
				spread: {
					driftPrice: signalData.driftPrice,
					kmnoPrice: signalData.kmnoPrice,
					spreadValue: signalData.spread,
				},
				positions: {
					drift: this.currentPosition?.drift || 0,
					kmno: this.currentPosition?.kmno || 0,
				},
			};
		} catch (error) {
			log.error('PERFORMANCE', 'Failed to capture snapshot', error as Error);
			return null;
		}
	}

	private async reconcilePosition(): Promise<void> {
		try {
			const exchangePosition = this.getCurrentSpreadPosition();

			if (!this.currentPosition && !exchangePosition) {
				return;
			}

			const targetSignal = this.currentPosition?.signal || 0;
			const targetDrift = targetSignal * TRADING_CONFIG.DRIFT_QUANTITY;
			const targetKmno = -targetSignal * TRADING_CONFIG.KMNO_QUANTITY;
			const actualDrift = exchangePosition?.drift || 0;
			const actualKmno = exchangePosition?.kmno || 0;

			const driftDiff = Math.abs(actualDrift - targetDrift);
			const kmnoDiff = Math.abs(actualKmno - targetKmno);

			if (driftDiff <= 0.1 && kmnoDiff <= 0.1) {
				this.currentPosition = exchangePosition;
				return;
			}

			log.position('Position reconciliation needed', {
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

				const driftBaseAmount = new BN(driftDiff * BASE_PRECISION_NUM);
				await this.executeOrder(
					driftMarketIndex,
					direction,
					driftBaseAmount,
					false,
					'Reconcile DRIFT'
				);
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

				const kmnoBaseAmount = new BN(kmnoDiff * BASE_PRECISION_NUM);
				await this.executeOrder(
					kmnoMarketIndex,
					direction,
					kmnoBaseAmount,
					false,
					'Reconcile KMNO'
				);
			}

			this.currentPosition = {
				drift: targetDrift,
				kmno: targetKmno,
				signal: targetSignal,
			};

			log.position('Position reconciliation completed');
		} catch (error) {
			log.error('RECONCILE', 'Position reconciliation failed', error as Error);
			this.state = BotState.EMERGENCY;
		}
	}
}
