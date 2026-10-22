import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Starts a single-node replica set (transactions need one). Set MONGODB_TEST_URI to reuse an existing
 * replica set instead (each test file uses its own database). MONGOMS_SYSTEM_BINARY can point at a local mongod.
 */
let rs: MongoMemoryReplSet | undefined;
export async function setup() {
  if (process.env.MONGODB_TEST_URI) return;
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_TEST_URI = rs.getUri();
}
export async function teardown() {
  await rs?.stop();
}
