import mongoose from 'mongoose';
import { env, isProd } from '../config/env';
import { logger } from '../lib/logger';
import { AppError } from '../lib/errors';
import { tenantGuardPlugin } from './tenantGuard';
import { detectCapabilities, getCapabilities, redactUri, transactionsHelp } from './capabilities';

mongoose.set('strictQuery', true);
mongoose.plugin(tenantGuardPlugin);

export async function connectDb(uri = env.MONGODB_URI) {
  try {
    await mongoose.connect(uri, { autoIndex: true, serverSelectionTimeoutMS: 10000 });
  } catch (err) {
    const reason = (err as { reason?: { type?: string; setName?: string | null } }).reason;
    const wantedSet = /[?&]replicaSet=([^&]+)/.exec(uri)?.[1];
    let hint = 'Check that the MongoDB service is running and that MONGODB_URI (host, port, credentials) is correct.';
    if (reason?.type === 'ReplicaSetNoPrimary' && wantedSet) {
      hint =
        `MONGODB_URI asks for replica set "${wantedSet}", but no primary of that set was found. Either mongod is running ` +
        `standalone (no replication.replSetName in mongod.cfg), the set was never initiated (run rs.initiate() once), or ` +
        `the member's configured host name is not reachable from this machine (check rs.conf().members[0].host). ` +
        `See docs/MONGODB-WINDOWS.md.`;
    }
    logger.error({ uri: redactUri(uri), error: (err as Error).name, topology: reason?.type }, `MongoDB connection failed. ${hint}`);
    throw err;
  }
  const caps = await detectCapabilities(mongoose.connection);
  logger.info({ db: mongoose.connection.name, uri: redactUri(uri), ...caps }, 'MongoDB connected');
  if (!caps.transactions) logger.error(`MongoDB transactions are NOT available. ${transactionsHelp(caps)}`);
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

/**
 * Build every model's indexes before the API accepts traffic. The unique indexes (single business, user email,
 * branch code, role key) are what make first-run setup and other creates safe under concurrency, so they must
 * exist before the first request — not be built lazily in the background.
 */
export async function ensureIndexes() {
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}

export function transactionsUnavailable() {
  const caps = getCapabilities();
  const detail = caps ? transactionsHelp(caps) : 'MongoDB transactions are unavailable.';
  return new AppError(
    503,
    'DATABASE_TRANSACTIONS_UNAVAILABLE',
    isProd ? 'The database is not ready. Please contact your administrator.' : `Database not ready: ${detail}`,
  );
}

/**
 * Run fn inside a transaction (requires a replica set — a single-node replica set is fine). Refuses up front, before
 * anything is written, when the deployment is known not to support transactions; there is no silent fallback to
 * non-transactional writes. The session is always ended, whether the transaction commits, aborts or throws.
 */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const caps = getCapabilities();
  if (caps && !caps.transactions) throw transactionsUnavailable();
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
