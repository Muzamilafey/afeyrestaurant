import { randomUUID } from 'node:crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectDb } from '../src/db/connect';
import { createApp } from '../src/app';
import { seedDemo, DEMO_PASSWORD } from '../src/scripts/seed';

export const app = createApp();
export const api = () => request(app);
export { DEMO_PASSWORD };

export async function setupDb() {
  const base = process.env.MONGODB_TEST_URI!;
  const u = new URL(base);
  u.pathname = `/chili_test_${randomUUID().slice(0, 8)}`;
  await connectDb(u.toString());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  return seedDemo();
}
export async function teardownDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export interface Session {
  token: string;
  branchId: string;
  branches: Array<{ id: string; code: string }>;
  permissions: string[];
  as: <T extends request.Test>(r: T) => T;
}

export async function login(email: string, opts: { password?: string; branchId?: string } = {}): Promise<Session> {
  const res = await api()
    .post('/api/v1/auth/login')
    .send({ email, password: opts.password ?? DEMO_PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const d = res.body.data;
  const branchId = opts.branchId ?? d.activeBranchId;
  return {
    token: d.accessToken,
    branchId,
    branches: d.branches,
    permissions: d.permissions,
    as: (r) => r.set('Authorization', `Bearer ${d.accessToken}`).set('X-Branch-Id', branchId ?? ''),
  };
}

export const uuid = () => randomUUID();
export const approval = { approverEmail: 'manager@chili.demo', pin: '2580' };
