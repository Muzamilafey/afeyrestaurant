import mongoose from 'mongoose';
import { Router } from 'express';
import { Job, NotificationJob } from '../../models';
import { detectCapabilities } from '../../db/capabilities';

/** Liveness (process up) and readiness (database reachable, worker backlog) probes. */
export const healthRouter = Router();
healthRouter.get('/health', (_req, res) => res.json({ status: 'ok', uptime: Math.round(process.uptime()), version: process.env.npm_package_version ?? '0.1.0' }));
healthRouter.get('/ready', async (_req, res) => {
  const dbOk = mongoose.connection.readyState === 1;
  let backlog: number | null = null;
  let ping = false;
  let transactions = false;
  try {
    await mongoose.connection.db!.admin().ping();
    ping = true;
    // Re-checked on every probe: a replica set can lose its primary, or mongod can be restarted without replication.
    transactions = (await detectCapabilities()).transactions;
    backlog = (await NotificationJob.countDocuments({ status: 'queued', runAt: { $lt: new Date(Date.now() - 10 * 60_000) } }).setOptions({ skipTenantGuard: true })) + (await Job.countDocuments({ status: 'queued', runAt: { $lt: new Date(Date.now() - 10 * 60_000) } }).setOptions({ skipTenantGuard: true }));
  } catch {
    /* reported below */
  }
  const ready = dbOk && ping && transactions;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', database: ping ? 'ok' : 'unreachable', transactions: ping ? (transactions ? 'ok' : 'unavailable') : 'unknown', staleQueuedJobs: backlog });
});
