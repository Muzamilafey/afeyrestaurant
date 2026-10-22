import http from 'node:http';
import { env, isProd } from './config/env';
import { connectDb, disconnectDb, ensureIndexes } from './db/connect';
import { getCapabilities, transactionsHelp } from './db/capabilities';
import { createApp } from './app';
import { attachRealtime } from './realtime/socket';
import { startScheduler } from './jobs/scheduler';
import { logger } from './lib/logger';

async function main() {
  await connectDb();
  const caps = getCapabilities()!;
  if (!caps.transactions) {
    // Setup, payments, stock and cash-up depend on transactions; never run production without them.
    if (isProd) throw new Error(`MongoDB transactions are unavailable — refusing to start. ${transactionsHelp(caps)}`);
    logger.warn('Starting anyway because NODE_ENV is not production: reads work, but every write that needs a transaction will fail with 503 DATABASE_TRANSACTIONS_UNAVAILABLE until MongoDB is a replica set. Run `npm run db:check` after fixing it.');
  }
  await ensureIndexes();
  const app = createApp();
  const server = http.createServer(app);
  const io = attachRealtime(server);
  const stopScheduler = env.RUN_WORKER_IN_PROCESS ? startScheduler() : () => undefined;
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'Chili POS API listening'));

  // Graceful shutdown: stop accepting connections, let in-flight requests finish, then close the DB.
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    io.close();
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
