import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticator } from 'otplib';
import { createModule } from '../../http/route';
import { User, Branch, Role, Terminal } from '../../models';
import { PERMISSIONS as P } from '../../auth/permissions';
import { getBusiness } from '../../services/setup';
import { hashPassword, verifyPassword, dummyVerify, passwordPolicy, pinPolicy } from '../../auth/password';
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllForUser } from '../../auth/tokens';
import { env, isTest } from '../../config/env';
import { AppError, badRequest, unauthorized } from '../../lib/errors';
import { encryptSecret, decryptSecret, randomToken, sha256 } from '../../lib/crypto';
import { audit } from '../../services/audit';
import { notify } from '../../services/notify';
import { buildContext } from '../../middleware/auth';

const COOKIE = 'chili_rt';
const cookieOpts = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/api/v1/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
});

/** Cookie-authenticated endpoints require this header: browsers cannot send it cross-site without passing CORS. */
function requireCsrfHeader(req: Request) {
  if (req.header('x-requested-with') !== 'chili-pos') throw new AppError(403, 'CSRF', 'Missing anti-CSRF header');
}

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 1000 : 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' } } });

async function sessionPayload(userId: string, req: Request) {
  const ctx = await buildContext(userId, null, req);
  const user = await User.findOne({ _id: userId }).setOptions({ skipTenantGuard: true }).lean();
  const business = await getBusiness();
  const branches = await Branch.find({ tenantId: ctx.tenantId, _id: { $in: ctx.allowedBranchIds } }, { name: 1, code: 1, settings: 1 }).lean();
  const role = user?.roleId ? await Role.findOne({ tenantId: ctx.tenantId, _id: user.roleId }, { key: 1, name: 1 }).lean() : null;
  return {
    user: { id: String(ctx.userId), name: ctx.userName, email: ctx.email, role: role ? { key: role.key, name: role.name } : null, mfaEnabled: !!user?.mfa?.enabled },
    business: business ? { id: String(business._id), name: business.name, branding: business.branding, settings: business.settings } : null,
    branches: branches.map((b) => ({ id: String(b._id), name: b.name, code: b.code, settings: b.settings })),
    activeBranchId: ctx.branchId ? String(ctx.branchId) : null,
    permissions: [...ctx.permissions],
  };
}

const m = createModule('/auth', 'Auth');

m.route(
  {
    method: 'post', path: '/login', summary: 'Sign in with email & password (and MFA code when enabled)', auth: 'public',
    middleware: [loginLimiter],
    body: z.object({ email: z.email(), password: z.string().min(1).max(200), mfaCode: z.string().regex(/^\d{6}$/).optional() }),
  },
  async ({ body, req, res }) => {
    const business = await getBusiness();
    if (!business) throw new AppError(409, 'NOT_SET_UP', 'This installation has not been set up yet');
    const user = await User.findOne({ tenantId: business._id, email: body.email.toLowerCase() }).select('+passwordHash +mfa.secretEnc');
    if (!user) {
      await dummyVerify(body.password);
      throw unauthorized('Invalid email or password');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Account temporarily locked.');
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok || !user.active) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= env.LOGIN_MAX_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000);
        user.failedLogins = 0;
        await audit(null, { action: 'auth.lockout', entity: 'User', entityId: user._id, meta: { email: user.email } }, req);
      }
      await user.save();
      throw unauthorized('Invalid email or password');
    }
    if (user.mfa?.enabled) {
      if (!body.mfaCode) throw new AppError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app');
      const secret = decryptSecret(user.mfa.secretEnc!);
      if (!authenticator.check(body.mfaCode, secret)) throw unauthorized('Invalid authentication code');
    }
    user.failedLogins = 0;
    user.lockedUntil = undefined;
    user.lastLoginAt = new Date();
    await user.save();
    const session = await sessionPayload(String(user._id), req);
    const accessToken = signAccessToken(user);
    const refresh = await issueRefreshToken(user._id, { ip: req.ip, userAgent: req.header('user-agent') });
    res.cookie(COOKIE, refresh, cookieOpts());
    await audit({ ...(await buildContext(String(user._id), null, req)) }, { action: 'auth.login', entity: 'User', entityId: user._id }, req);
    if (session.permissions.includes('settings.manage')) {
      await notify(user.tenantId, { event: 'login_alert', channel: 'email', to: user.email, vars: { name: user.name, ip: req.ip, time: new Date().toISOString() }, dedupeKey: `login:${user._id}:${Date.now()}` }).catch(() => undefined);
    }
    return { accessToken, ...session };
  },
);

m.route({ method: 'post', path: '/refresh', summary: 'Rotate refresh cookie and get a new access token', auth: 'public' }, async ({ req, res }) => {
  requireCsrfHeader(req);
  const token = req.cookies?.[COOKIE];
  if (!token) throw unauthorized('No session');
  const { userId, token: next } = await rotateRefreshToken(token, { ip: req.ip, userAgent: req.header('user-agent') });
  const user = await User.findOne({ _id: userId }).setOptions({ skipTenantGuard: true });
  if (!user || !user.active) throw unauthorized('Account disabled');
  res.cookie(COOKIE, next, cookieOpts());
  return { accessToken: signAccessToken(user), ...(await sessionPayload(String(user._id), req)) };
});

m.route({ method: 'post', path: '/logout', summary: 'Revoke the current refresh token', auth: 'public' }, async ({ req, res }: { req: Request; res: Response }) => {
  requireCsrfHeader(req);
  const token = req.cookies?.[COOKIE];
  if (token) await revokeRefreshToken(token);
  res.clearCookie(COOKIE, { path: '/api/v1/auth' });
  return { ok: true };
});

m.route({ method: 'get', path: '/me', summary: 'Current session details', auth: 'user' }, async ({ ctx, req }) => sessionPayload(String(ctx.userId), req));

m.route(
  { method: 'post', path: '/change-password', summary: 'Change own password (revokes other sessions)', auth: 'user', body: z.object({ currentPassword: z.string(), newPassword: z.string().max(200) }) },
  async ({ ctx, body, req }) => {
    const user = await User.findOne({ _id: ctx.userId }).setOptions({ skipTenantGuard: true }).select('+passwordHash');
    if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) throw badRequest('Current password is incorrect');
    const policy = passwordPolicy(body.newPassword);
    if (policy) throw badRequest(policy);
    user.passwordHash = await hashPassword(body.newPassword);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    await revokeAllForUser(user._id);
    await audit(ctx, { action: 'auth.password_changed', entity: 'User', entityId: user._id }, req);
    return { ok: true, accessToken: signAccessToken(user) };
  },
);

/** Every user can change their own PIN (numbers only). Confirm with the current PIN, or the password if no PIN is set yet. */
m.route(
  { method: 'post', path: '/pin', summary: 'Change own PIN (4–6 digits)', auth: 'user', body: z.object({ currentPin: z.string().regex(/^\d{4,6}$/).optional(), currentPassword: z.string().max(200).optional(), pin: z.string() }) },
  async ({ ctx, body, req }) => {
    const user = await User.findOne({ _id: ctx.userId }).setOptions({ skipTenantGuard: true }).select('+passwordHash +pinHash');
    if (!user) throw unauthorized();
    const verified = (body.currentPin && user.pinHash && (await verifyPassword(user.pinHash, body.currentPin))) || (body.currentPassword && (await verifyPassword(user.passwordHash, body.currentPassword)));
    if (!verified) throw badRequest(user.pinHash ? 'Current PIN is incorrect' : 'Enter your password to set your first PIN');
    const policy = pinPolicy(body.pin);
    if (policy) throw badRequest(policy);
    user.pinHash = await hashPassword(body.pin);
    await user.save();
    await audit(ctx, { action: 'auth.pin_changed', entity: 'User', entityId: user._id }, req);
    return { ok: true };
  },
);

// ── PIN sign-in on registered POS terminals ──
// A manager registers a device once; the device keeps a long random terminal token. Only registered devices can
// list staff and accept PIN sign-ins, so PINs cannot be guessed from arbitrary machines on the internet.
async function terminalFromRequest(req: Request) {
  const token = req.header('x-terminal-token');
  if (!token || token.length < 40) throw new AppError(401, 'TERMINAL_REQUIRED', 'This device is not registered for PIN sign-in');
  const t = await Terminal.findOne({ tokenHash: sha256(token), active: true }).setOptions({ skipTenantGuard: true });
  if (!t) throw new AppError(401, 'TERMINAL_REQUIRED', 'This device is not registered for PIN sign-in');
  return t;
}
const pinLimiter = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 1000 : 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } } });

m.route(
  { method: 'post', path: '/terminal/register', summary: 'Register this device as a PIN sign-in terminal for the active branch', permission: P.TERMINALS_MANAGE, body: z.object({ name: z.string().min(1).max(40) }), status: 201 },
  async ({ ctx, body, req }) => {
    const token = `ctm_${randomToken(32)}`;
    const t = await Terminal.create({ tenantId: ctx.tenantId, branchId: ctx.branchId, name: body.name, deviceKey: randomToken(12), tokenHash: sha256(token), registeredBy: ctx.userId });
    await audit(ctx, { action: 'terminal.registered', entity: 'Terminal', entityId: t._id, meta: { name: body.name } }, req);
    return { terminalId: String(t._id), terminalToken: token, name: t.name };
  },
);

m.route({ method: 'get', path: '/terminal/staff', summary: 'Staff who can sign in on this terminal (registered devices only)', auth: 'public', middleware: [pinLimiter] }, async ({ req }) => {
  const t = await terminalFromRequest(req);
  t.lastSeenAt = new Date();
  await t.save();
  const [business, branch, roles] = await Promise.all([getBusiness(), Branch.findOne({ tenantId: t.tenantId, _id: t.branchId }).lean(), Role.find({ tenantId: t.tenantId }).lean()]);
  const allBranchRoles = roles.filter((r) => !r.branchScoped).map((r) => r._id);
  const users = await User.find({ tenantId: t.tenantId, active: true, $or: [{ branchIds: t.branchId }, { roleId: { $in: allBranchRoles } }] }).select('+pinHash').sort({ name: 1 }).lean();
  return {
    business: { name: business?.name, logoUrl: business?.branding?.logoUrl ?? null },
    branch: { id: String(t.branchId), name: branch?.name },
    terminal: { id: String(t._id), name: t.name },
    // Minimal details only: first name + initial, role name, whether a PIN is set.
    staff: users.map((u) => {
      const parts = u.name.trim().split(/\s+/);
      return { id: String(u._id), displayName: parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0], role: roles.find((r) => String(r._id) === String(u.roleId))?.name ?? '', hasPin: !!u.pinHash };
    }),
  };
});

m.route(
  { method: 'post', path: '/pin-login', summary: 'Sign in with a staff PIN on a registered terminal', auth: 'public', middleware: [pinLimiter], body: z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/i), pin: z.string().regex(/^\d{4,6}$/) }) },
  async ({ body, req, res }) => {
    const t = await terminalFromRequest(req);
    const user = await User.findOne({ tenantId: t.tenantId, _id: body.userId, active: true }).select('+pinHash');
    if (!user) throw unauthorized('Incorrect PIN');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many wrong PINs. Ask a manager or try again later.');
    if (!user.pinHash) throw new AppError(409, 'NO_PIN', 'No PIN set for this account. Sign in with email, then set a PIN.');
    if (!(await verifyPassword(user.pinHash, body.pin))) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= env.LOGIN_MAX_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000);
        user.failedLogins = 0;
      }
      await user.save();
      throw unauthorized('Incorrect PIN');
    }
    const role = await Role.findOne({ tenantId: t.tenantId, _id: user.roleId }).lean();
    if (role?.branchScoped && !(user.branchIds ?? []).some((b) => String(b) === String(t.branchId))) throw new AppError(403, 'FORBIDDEN', 'You are not assigned to this branch');
    user.failedLogins = 0;
    user.lockedUntil = undefined;
    user.lastLoginAt = new Date();
    await user.save();
    req.headers['x-branch-id'] = String(t.branchId);
    const session = await sessionPayload(String(user._id), req);
    const refresh = await issueRefreshToken(user._id, { ip: req.ip, userAgent: req.header('user-agent') });
    res.cookie(COOKIE, refresh, cookieOpts());
    await audit(await buildContext(String(user._id), null, req), { action: 'auth.pin_login', entity: 'User', entityId: user._id, meta: { terminal: t.name } }, req);
    return { accessToken: signAccessToken(user), ...session, activeBranchId: String(t.branchId) };
  },
);

m.route({ method: 'post', path: '/mfa/setup', summary: 'Begin TOTP MFA enrolment', auth: 'user' }, async ({ ctx }) => {
  const secret = authenticator.generateSecret();
  const user = await User.findOne({ _id: ctx.userId }).setOptions({ skipTenantGuard: true });
  if (!user) throw unauthorized();
  if (user.mfa?.enabled) throw badRequest('MFA is already enabled');
  user.set('mfa.secretEnc', encryptSecret(secret));
  await user.save();
  return { secret, otpauthUrl: authenticator.keyuri(ctx.email, 'Chili POS', secret) };
});

m.route(
  { method: 'post', path: '/mfa/enable', summary: 'Confirm TOTP code to enable MFA', auth: 'user', body: z.object({ code: z.string().regex(/^\d{6}$/) }) },
  async ({ ctx, body, req }) => {
    const user = await User.findOne({ _id: ctx.userId }).setOptions({ skipTenantGuard: true }).select('+mfa.secretEnc');
    if (!user?.mfa?.secretEnc) throw badRequest('Start MFA setup first');
    if (!authenticator.check(body.code, decryptSecret(user.mfa.secretEnc))) throw badRequest('Invalid code');
    user.set('mfa.enabled', true);
    await user.save();
    await audit(ctx, { action: 'auth.mfa_enabled', entity: 'User', entityId: user._id }, req);
    return { ok: true };
  },
);

const resetLimiter = rateLimit({ windowMs: 60 * 60_000, limit: isTest ? 1000 : 5, standardHeaders: 'draft-8', legacyHeaders: false });

m.route(
  { method: 'post', path: '/password-reset/request', summary: 'Request a password reset email', auth: 'public', middleware: [resetLimiter], body: z.object({ email: z.email() }) },
  async ({ body }) => {
    const business = await getBusiness();
    if (business) {
      const tenantId = business._id;
      const user = await User.findOne({ tenantId, email: body.email.toLowerCase(), active: true });
      if (user) {
        const token = randomToken(32);
        user.passwordResetTokenHash = sha256(token);
        user.passwordResetExpires = new Date(Date.now() + 30 * 60_000);
        await user.save();
        const link = `${env.CORS_ORIGINS.split(',')[0]}/reset-password?token=${token}`;
        await notify(tenantId, { event: 'password_reset', channel: 'email', to: user.email, vars: { name: user.name, reset_link: link, restaurant_name: business.name }, dedupeKey: `pwreset:${sha256(token)}` });
      }
    }
    // Always the same response so the endpoint cannot be used to enumerate accounts.
    return { ok: true, message: 'If the account exists, a reset link has been sent.' };
  },
);

m.route(
  { method: 'post', path: '/password-reset/confirm', summary: 'Complete a password reset', auth: 'public', middleware: [resetLimiter], body: z.object({ token: z.string().min(20), newPassword: z.string().max(200) }) },
  async ({ body, req }) => {
    const business = await getBusiness();
    if (!business) throw badRequest('Invalid or expired reset link');
    const user = await User.findOne({ tenantId: business._id, passwordResetTokenHash: sha256(body.token) }).select('+passwordResetTokenHash +passwordResetExpires');
    if (!user || !user.passwordResetExpires || user.passwordResetExpires < new Date()) throw badRequest('Invalid or expired reset link');
    const policy = passwordPolicy(body.newPassword);
    if (policy) throw badRequest(policy);
    user.passwordHash = await hashPassword(body.newPassword);
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpires = undefined;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.failedLogins = 0;
    user.lockedUntil = undefined;
    await user.save();
    await revokeAllForUser(user._id);
    await audit(null, { action: 'auth.password_reset', entity: 'User', entityId: user._id }, req);
    return { ok: true };
  },
);

export default m;
