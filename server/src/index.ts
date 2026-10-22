import http from 'node:http';
import { env } from './config/env';
import { connectDb, disconnectDb } from './db/connect';
import { createApp } from './app';
import { attachRealtime } from './realtime/socket';
import { startScheduler } from './jobs/scheduler';
import { logger } from './lib/logger';

async function main() {
  await connectDb();
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
