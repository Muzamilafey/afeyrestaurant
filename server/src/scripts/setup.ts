/**
 * First-run setup from the command line (alternative to the web setup screen):
 *   npm run setup -- --name "Afey Restaurant" --branch "Main" --code MAIN --owner "Jane Doe" --email owner@example.com
 * The owner password is read from the OWNER_PASSWORD environment variable (never pass passwords as arguments).
 */
import { connectDb, disconnectDb } from '../db/connect';
import { setupBusiness, getBusiness } from '../services/setup';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg('name');
  const email = arg('email');
  const ownerName = arg('owner');
  const password = process.env.OWNER_PASSWORD;
  if (!name || !email || !ownerName || !password) {
    console.error('Usage: OWNER_PASSWORD=... npm run setup -- --name "Business" --owner "Owner Name" --email owner@example.com [--branch "Main" --code MAIN]');
    process.exit(2);
  }
  await connectDb();
  if (await getBusiness()) {
    console.error('This installation is already set up.');
    process.exit(1);
  }
  const r = await setupBusiness({ name, branch: { name: arg('branch') ?? 'Main', code: arg('code') ?? 'MAIN' }, owner: { name: ownerName, email, password } });
  console.log(`Set up "${r.business.name}" with branch ${r.branch.code}. Sign in as ${email}.`);
  await disconnectDb();
}
main().catch(async (e) => {
  console.error(e.message ?? e);
  await disconnectDb();
  process.exit(1);
});
