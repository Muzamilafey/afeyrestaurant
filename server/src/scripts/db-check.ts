/**
 * Database diagnostics: `npm run db:check` (or `node dist/scripts/db-check.js` in production).
 * Prints the effective connection string with secrets masked, the deployment type (standalone / replica set /
 * sharded), whether transactions work, driver versions and the setup state. It writes nothing: the transaction
 * probe inserts into a scratch collection inside a transaction that is always aborted.
 * Exit code 0 = ready, 1 = not ready.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { detectCapabilities, redactUri, transactionsHelp } from '../db/capabilities';

const out = (label: string, value: unknown) => console.log(`${label.padEnd(22)} ${value}`);

async function probeTransaction(): Promise<string> {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await mongoose.connection.db!.collection('_chili_txn_probe').insertOne({ at: new Date() }, { session });
    await session.abortTransaction();
    return 'ok (probe transaction started and rolled back)';
  } catch (e) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
    const err = e as { code?: number; codeName?: string; message?: string };
    return `FAILED — ${err.codeName ?? 'error'} (${err.code ?? '?'}): ${err.message}`;
  } finally {
    await session.endSession();
  }
}

async function main() {
  const uri = env.MONGODB_URI;
  out('NODE_ENV', env.NODE_ENV);
  out('MONGODB_URI', redactUri(uri));
  out('URI replicaSet option', /[?&]replicaSet=([^&]+)/.exec(uri)?.[1] ?? '(none)');
  out('mongoose / driver', `${mongoose.version} / ${require('mongodb/package.json').version}`);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false });
  } catch (e) {
    const reason = (e as { reason?: { type?: string } }).reason;
    out('connection', `FAILED — ${(e as Error).name}${reason?.type ? ` (${reason.type})` : ''}`);
    if ((e as { code?: number }).code === 18) console.log('\nAuthentication failed: check the user name, password and authSource in MONGODB_URI.');
    if (reason?.type === 'ReplicaSetNoPrimary') {
      console.log('\nThe URI asks for a replica set but no primary answered. Either mongod has no replication.replSetName,');
      console.log('the set was never initiated (rs.initiate()), or rs.conf().members[0].host is not reachable from here.');
      console.log('Tip: try the same URI without ?replicaSet=... to see what the server reports. See docs/MONGODB-WINDOWS.md.');
    }
    process.exitCode = 1;
    return;
  }
  const caps = await detectCapabilities();
  out('database', caps.database);
  out('server version', caps.serverVersion ?? 'unknown');
  out('deployment', caps.deployment + (caps.setName ? ` (set "${caps.setName}")` : ''));
  out('writable primary', caps.isWritablePrimary);
  out('transactions', caps.transactions ? await probeTransaction() : 'NOT AVAILABLE');
  const major = Number(caps.serverVersion?.split('.')[0] ?? 0);
  if (major && major < 5) out('warning', 'MongoDB 5.0 or newer is recommended (mongoose 8 / driver 6 support 4.2+ for transactions).');

  const db = mongoose.connection.db!;
  const businesses = await db.collection('tenants').find({}, { projection: { name: 1, setupCompletedAt: 1 } }).toArray();
  out('setup', businesses.length === 0 ? 'not done yet (open the web app to run first-run setup)' : `done — "${businesses[0].name}"${businesses[0].setupCompletedAt ? ` at ${businesses[0].setupCompletedAt.toISOString()}` : ''}`);
  if (businesses.length > 1) out('warning', `${businesses.length} business documents found — expected exactly one`);
  const ids = businesses.map((b) => b._id);
  for (const coll of ['users', 'branches', 'roles']) {
    const orphans = await db.collection(coll).countDocuments({ tenantId: { $nin: ids } });
    if (orphans) out('warning', `${orphans} ${coll} not linked to the business (left over from an older failed setup?)`);
  }

  const ok = caps.transactions;
  console.log(`\n${ok ? 'READY — the database supports everything Chili POS needs.' : `NOT READY — ${transactionsHelp(caps)}`}`);
  process.exitCode = ok ? 0 : 1;
}

main()
  .catch((e) => {
    console.error('db:check failed:', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
