import { SpreadBot } from './bot';
import { log } from './logger';

let bot: SpreadBot | null = null;
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
	if (isShuttingDown) return;

	isShuttingDown = true;
	log.cycle(0, 'Shutdown initiated', { signal });

	try {
		if (bot) {
			await bot.stop();
		}
		log.cycle(0, 'Shutdown completed');
		process.exit(0);
	} catch (error) {
		log.error('SHUTDOWN', 'Shutdown failed', error as Error);
		process.exit(1);
	}
}

async function main(): Promise<void> {
	try {
		log.cycle(0, 'Momentum bot starting');

		process.on('SIGINT', () => shutdown('SIGINT'));
		process.on('SIGTERM', () => shutdown('SIGTERM'));
		process.on('uncaughtException', (error) => {
			log.error('FATAL', 'Uncaught exception', error);
			shutdown('UNCAUGHT_EXCEPTION');
		});
		process.on('unhandledRejection', (reason) => {
			log.error('FATAL', 'Unhandled rejection', new Error(String(reason)));
			shutdown('UNHANDLED_REJECTION');
		});

		bot = new SpreadBot();

		const initResult = await bot.initialize();
		if (!initResult.success) {
			log.error(
				'MAIN',
				'Bot initialization failed',
				new Error(initResult.error)
			);
			process.exit(1);
		}

		bot.start();
		log.cycle(0, 'Momentum bot running');
	} catch (error) {
		log.error('MAIN', 'Fatal error', error as Error);
		process.exit(1);
	}
}

main().catch((error) => {
	log.error('MAIN', 'Unhandled main error', error as Error);
	process.exit(1);
});
