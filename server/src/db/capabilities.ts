import mongoose from 'mongoose';

/**
 * What the connected MongoDB deployment can do. Chili POS needs multi-document transactions (setup, payments,
 * stock movements, cash-up, offline sync) and those only exist on a replica set member or a mongos — a plain
 * standalone `mongod` rejects them with code 20 "Transaction numbers are only allowed on a replica set member or
 * mongos". A single-node replica set is enough.
 */
export interface DbCapabilities {
  deployment: 'standalone' | 'replicaSet' | 'sharded';
  setName: string | null;
  isWritablePrimary: boolean;
  transactions: boolean;
  serverVersion: string | null;
  database: string;
}

let cached: DbCapabilities | null = null;

/** Last detected capabilities of the current connection (null until detectCapabilities has run). */
export const getCapabilities = () => cached;

/** Test hook: lets tests simulate a deployment whose capabilities were detected wrongly or have changed. */
export function setCapabilitiesForTest(c: DbCapabilities | null) {
  cached = c;
}

export async function detectCapabilities(conn: mongoose.Connection = mongoose.connection): Promise<DbCapabilities> {
  const admin = conn.db!.admin();
  const hello = (await admin.command({ hello: 1 })) as { msg?: string; setName?: string; isWritablePrimary?: boolean; logicalSessionTimeoutMinutes?: number | null };
  let serverVersion: string | null = null;
  try {
    serverVersion = ((await admin.command({ buildInfo: 1 })) as { version?: string }).version ?? null;
  } catch {
    /* buildInfo can be restricted for some roles; the version is informational only */
  }
  const deployment = hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replicaSet' : 'standalone';
  const isWritablePrimary = !!hello.isWritablePrimary;
  const sessions = hello.logicalSessionTimeoutMinutes != null;
  cached = {
    deployment,
    setName: hello.setName ?? null,
    isWritablePrimary,
    transactions: sessions && (deployment === 'sharded' || (deployment === 'replicaSet' && isWritablePrimary)),
    serverVersion,
    database: conn.name,
  };
  return cached;
}

/** Connection string safe for logs: user name kept, password and secret-looking query parameters masked. */
export function redactUri(uri: string): string {
  try {
    const u = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    const scheme = uri.startsWith('mongodb+srv://') ? 'mongodb+srv://' : 'mongodb://';
    if (u.password) u.password = '****';
    for (const k of [...u.searchParams.keys()]) {
      if (/pass|secret|token|key|credential/i.test(k)) u.searchParams.set(k, '****');
    }
    // URL() only parses the first host of a seed list; keep the original host part instead.
    const hosts = uri.replace(/^mongodb(\+srv)?:\/\//, '').split('/')[0].split('@').pop();
    const auth = u.username ? `${u.username}${u.password ? ':****' : ''}@` : '';
    return `${scheme}${auth}${hosts}${u.pathname}${u.search}`;
  } catch {
    return 'mongodb://<unparseable connection string>';
  }
}

/** Operator-facing explanation of why transactions are unavailable and how to fix it. */
export function transactionsHelp(c: DbCapabilities): string {
  if (c.deployment === 'standalone') {
    return (
      'MongoDB is running as a standalone server, which cannot run transactions. Convert it to a single-node replica set ' +
      '(keeps all existing data): add `replication: { replSetName: rs0 }` to mongod.cfg, restart the MongoDB service, run ' +
      "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] }) once in mongosh, and use " +
      'MONGODB_URI=mongodb://127.0.0.1:27017/chili_pos?replicaSet=rs0. See docs/MONGODB-WINDOWS.md (or docs/SETUP.md on Linux).'
    );
  }
  if (c.deployment === 'replicaSet' && !c.isWritablePrimary) {
    return `Connected to replica set "${c.setName}" but not to a writable primary. Check rs.status() — the member may still be electing a primary or be a secondary.`;
  }
  return 'The MongoDB deployment does not report session support, so transactions are unavailable. MongoDB 4.2 or newer on a replica set is required.';
}
