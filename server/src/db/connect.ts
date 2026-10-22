import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { tenantGuardPlugin } from './tenantGuard';

mongoose.set('strictQuery', true);
mongoose.plugin(tenantGuardPlugin);

export async function connectDb(uri = env.MONGODB_URI) {
  await mongoose.connect(uri, { autoIndex: true, serverSelectionTimeoutMS: 10000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

/** Run fn inside a transaction (requires a replica set — a single-node replica set is fine). */
export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
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
