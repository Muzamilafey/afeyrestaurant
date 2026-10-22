import type { ClientSession } from 'mongoose';
import { Business, Branch, Role, User, TaxRate } from '../models';
import { SYSTEM_ROLES } from '../auth/permissions';
import { hashPassword, passwordPolicy } from '../auth/password';
import { badRequest, conflict } from '../lib/errors';
import { withTransaction } from '../db/connect';

export interface SetupInput {
  name: string;
  contactEmail?: string;
  contactPhone?: string;
  branch: { name: string; code: string; address?: string; phone?: string };
  owner: { name: string; email: string; password: string; phone?: string };
}

export async function ensureSystemRoles(tenantId: unknown, session?: ClientSession) {
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    await Role.updateOne(
      { tenantId, key },
      { $set: { name: def.name, description: def.description, permissions: def.permissions, branchScoped: def.branchScoped, system: true } },
      { upsert: true, session },
    );
  }
}

/** The single business of this installation (null until first-run setup has been completed). */
export const getBusiness = () => Business.findOne({ singleton: 'business' }).lean();

/**
 * First-run setup: creates the business, its first branch, the system roles, the owner account and default taxes.
 * Refuses to run once a business exists — there is exactly one business per installation.
 */
export async function setupBusiness(input: SetupInput) {
  const policy = passwordPolicy(input.owner.password);
  if (policy) throw badRequest(policy);
  if (await getBusiness()) throw conflict('This installation is already set up', 'ALREADY_SET_UP');
  const passwordHash = await hashPassword(input.owner.password);
  try {
    return await withTransaction(async (session) => {
      const [business] = await Business.create([{ name: input.name, contactEmail: input.contactEmail ?? input.owner.email, contactPhone: input.contactPhone }], { session });
      const [branch] = await Branch.create([{ tenantId: business._id, ...input.branch, code: input.branch.code.toUpperCase() }], { session });
      await ensureSystemRoles(business._id, session);
      const ownerRole = await Role.findOne({ tenantId: business._id, key: 'owner' }).session(session);
      const [owner] = await User.create(
        [{ tenantId: business._id, email: input.owner.email.toLowerCase(), name: input.owner.name, phone: input.owner.phone, passwordHash, roleId: ownerRole!._id, branchIds: [branch._id], defaultBranchId: branch._id }],
        { session },
      );
      // Kenyan defaults — editable in Settings → Taxes. VAT 16% (standard rate) and the 2% Catering Levy (off by default).
      await TaxRate.create(
        [
          { tenantId: business._id, name: 'VAT 16%', code: 'VAT', rateBps: 1600, inclusive: true, active: true },
          { tenantId: business._id, name: 'Catering Levy 2%', code: 'CTL', rateBps: 200, inclusive: true, active: false },
        ],
        { session, ordered: true },
      );
      return { business, branch, owner };
    });
  } catch (e) {
    // The singleton unique index makes concurrent setup attempts fail safely.
    if ((e as { code?: number }).code === 11000) throw conflict('This installation is already set up', 'ALREADY_SET_UP');
    throw e;
  }
}
