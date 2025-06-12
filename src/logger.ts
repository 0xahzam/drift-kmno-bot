import winston from 'winston';
import type { PerformanceSnapshot } from './types';

const format = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
	winston.format.printf(
		({ timestamp, level, message, component, data, correlationId }) => {
			const prefix = component ? `[${component}]` : '';
			const correlation = correlationId ? ` (${correlationId})` : '';
			const structured = data ? ` ${JSON.stringify(data)}` : '';
			return `${timestamp} ${level.toUpperCase()} ${prefix}${correlation} ${message}${structured}`;
		}
	)
);

const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: format,
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({ filename: 'bot.log' }),
	],
});

export const log = {
	cycle: (cycleId: number, message: string, data?: any) =>
		logger.info(message, {
			component: 'CYCLE',
			correlationId: `cycle-${cycleId}`,
			data,
		}),

	order: (action: string, market: string, message: string, data?: any) =>
		logger.info(message, {
			component: 'ORDER',
			correlationId: `${market}-${Date.now()}`,
			data,
		}),

	risk: (message: string, data?: any) =>
		logger.warn(message, { component: 'RISK', data }),

	position: (message: string, data?: any) =>
		logger.info(message, { component: 'POSITION', data }),

	snapshot: (snapshot: PerformanceSnapshot) =>
		logger.info('SNAPSHOT', {
			component: 'PERFORMANCE',
			data: snapshot,
		}),

	error: (component: string, message: string, error: Error) =>
		logger.error(message, {
			component,
			data: { error: error.message, stack: error.stack },
		}),
};
