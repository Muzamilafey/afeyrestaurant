/**
 * INTEGRATION test against a real STANDALONE mongod — the configuration that produced
 * "Transaction numbers are only allowed on a replica set member or mongos" (code 20) during first-run setup.
 * Uses MONGODB_TEST_STANDALONE_URI if set, otherwise starts a standalone mongodb-memory-server instance.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDb, ensureIndexes, withTransaction } from '../src/db/connect';
import { getCapabilities, setCapabilitiesForTest } from '../src/db/capabilities';
import { createApp } from '../src/app';

const app = createApp();
const api = () => request(app);
let server: MongoMemoryServer | undefined;

const body = { name: 'Afey Restaurant', branch: { name: 'Main', code: 'MAIN' }, owner: { name: 'Owner One', email: 'owner@afey.co.ke', password: 'Str0ng#Passw0rd!' } };
const total = async () => {
  let n = 0;
  for (const c of ['tenants', 'branches', 'roles', 'users', 'taxrates']) n += await mongoose.connection.db!.collection(c).countDocuments();
  return n;
};

beforeAll(async () => {
  let base = process.env.MONGODB_TEST_STANDALONE_URI;
  if (!base) {
    server = await MongoMemoryServer.create();
    base = server.getUri();
  }
  const u = new URL(base);
  u.pathname = `/chili_standalone_${randomUUID().slice(0, 8)}`;
  await connectDb(u.toString());
  await ensureIndexes();
});
afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await server?.stop();
});

describe('standalone mongod (no replica set)', () => {
  it('is detected as standalone without transactions', () => {
    expect(getCapabilities()).toMatchObject({ deployment: 'standalone', transactions: false, setName: null });
  });

  it('setup answers 503 DATABASE_TRANSACTIONS_UNAVAILABLE and writes nothing', async () => {
    const res = await api().post('/api/v1/setup').send(body);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_TRANSACTIONS_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/MongoServerError|Transaction numbers|stack|IllegalOperation/);
    expect(await total()).toBe(0);
    expect((await api().get('/api/v1/business')).body.data.configured).toBe(false);
  });

  it('withTransaction refuses before opening a session', async () => {
    let ran = false;
    await expect(withTransaction(async () => { ran = true; })).rejects.toMatchObject({ status: 503, code: 'DATABASE_TRANSACTIONS_UNAVAILABLE' });
    expect(ran).toBe(false);
  });

  it('even if detection were wrong, the server error (code 20) maps to 503 and nothing is written', async () => {
    const real = getCapabilities();
    setCapabilitiesForTest({ ...real!, transactions: true });
    try {
      const res = await api().post('/api/v1/setup').send(body);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('DATABASE_TRANSACTIONS_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/MongoServerError|Transaction numbers|stack/);
      expect(await total()).toBe(0);
    } finally {
      setCapabilitiesForTest(real);
    }
  });

  it('readiness probe reports not ready', async () => {
    const res = await api().get('/api/v1/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'not_ready', database: 'ok', transactions: 'unavailable' });
  });
});
