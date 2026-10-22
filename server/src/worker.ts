/** Standalone background worker (run with PM2 alongside the API when RUN_WORKER_IN_PROCESS=false). */
import { connectDb, disconnectDb } from './db/connect';
import { startScheduler } from './jobs/scheduler';
import { logger } from './lib/logger';

async function main() {
  await connectDb();
  const stop = startScheduler();
  const shutdown = async () => {
    stop();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((err) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
