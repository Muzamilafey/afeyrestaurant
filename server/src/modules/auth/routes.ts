import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticator } from 'otplib';
import { createModule } from '../../http/route';
import { User, Tenant, Branch, Role } from '../../models';
import { hashPassword, verifyPassword, dummyVerify, passwordPolicy } from '../../auth/password';
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
  const tenant = ctx.tenantId ? await Tenant.findById(ctx.tenantId).lean() : null;
  const branches = ctx.tenantId ? await Branch.find({ tenantId: ctx.tenantId, _id: { $in: ctx.allowedBranchIds } }, { name: 1, code: 1, settings: 1 }).lean() : [];
  const role = user?.roleId && ctx.tenantId ? await Role.findOne({ tenantId: ctx.tenantId, _id: user.roleId }, { key: 1, name: 1 }).lean() : null;
  return {
    user: { id: String(ctx.userId), name: ctx.userName, email: ctx.email, role: role ? { key: role.key, name: role.name } : null, isPlatformAdmin: ctx.isPlatformAdmin, mfaEnabled: !!user?.mfa?.enabled, hasPin: undefined as boolean | undefined },
    tenant: tenant ? { id: String(tenant._id), name: tenant.name, slug: tenant.slug, status: tenant.status, branding: tenant.branding, settings: tenant.settings } : null,
    branches: branches.map((b) => ({ id: String(b._id), name: b.name, code: b.code, settings: b.settings })),
    activeBranchId: ctx.branchId ? String(ctx.branchId) : null,
    permissions: [...ctx.permissions],
    features: [...ctx.features],
  };
}

const m = createModule('/auth', 'Auth');

m.route(
  {
    method: 'post', path: '/login', summary: 'Sign in with email & password (and MFA code when enabled)', auth: 'public',
    middleware: [loginLimiter],
    body: z.object({ email: z.email(), password: z.string().min(1).max(200), tenantSlug: z.string().max(60).optional(), mfaCode: z.string().regex(/^\d{6}$/).optional() }),
  },
  async ({ body, req, res }) => {
    // Resolve the tenant from the trusted hostname first, then the explicit slug; otherwise this is a platform login.
    let tenantId = req.hostTenantId ?? null;
    if (!tenantId && body.tenantSlug) {
      tenantId = (await Tenant.findOne({ slug: body.tenantSlug.toLowerCase() }, { _id: 1 }).lean())?._id ?? null;
      if (!tenantId) {
        await dummyVerify(body.password);
        throw unauthorized('Invalid email or password');
      }
    }
    const user = await User.findOne({ tenantId, email: body.email.toLowerCase() }).select('+passwordHash +mfa.secretEnc');
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
    if (user.tenantId && session.permissions.includes('settings.manage')) {
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

m.route(
  { method: 'post', path: '/pin', summary: 'Set own POS approval PIN', auth: 'user', body: z.object({ currentPassword: z.string(), pin: z.string().regex(/^\d{4,8}$/) }) },
  async ({ ctx, body, req }) => {
    const user = await User.findOne({ _id: ctx.userId }).setOptions({ skipTenantGuard: true }).select('+passwordHash');
    if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) throw badRequest('Current password is incorrect');
    user.pinHash = await hashPassword(body.pin);
    await user.save();
    await audit(ctx, { action: 'auth.pin_set', entity: 'User', entityId: user._id }, req);
    return { ok: true };
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
  { method: 'post', path: '/password-reset/request', summary: 'Request a password reset email', auth: 'public', middleware: [resetLimiter], body: z.object({ email: z.email(), tenantSlug: z.string().optional() }) },
  async ({ body, req }) => {
    let tenantId = req.hostTenantId ?? null;
    if (!tenantId && body.tenantSlug) tenantId = (await Tenant.findOne({ slug: body.tenantSlug.toLowerCase() }, { _id: 1 }).lean())?._id ?? null;
    if (tenantId) {
      const user = await User.findOne({ tenantId, email: body.email.toLowerCase(), active: true });
      if (user) {
        const token = randomToken(32);
        user.passwordResetTokenHash = sha256(token);
        user.passwordResetExpires = new Date(Date.now() + 30 * 60_000);
        await user.save();
        const tenant = await Tenant.findById(tenantId).lean();
        const link = `${env.CORS_ORIGINS.split(',')[0]}/reset-password?token=${token}&tenant=${tenant?.slug}`;
        await notify(tenantId, { event: 'password_reset', channel: 'email', to: user.email, vars: { name: user.name, reset_link: link, restaurant_name: tenant?.name }, dedupeKey: `pwreset:${sha256(token)}` });
      }
    }
    // Always the same response so the endpoint cannot be used to enumerate accounts.
    return { ok: true, message: 'If the account exists, a reset link has been sent.' };
  },
);

m.route(
  { method: 'post', path: '/password-reset/confirm', summary: 'Complete a password reset', auth: 'public', middleware: [resetLimiter], body: z.object({ token: z.string().min(20), tenantSlug: z.string(), newPassword: z.string().max(200) }) },
  async ({ body, req }) => {
    const tenant = await Tenant.findOne({ slug: body.tenantSlug.toLowerCase() }, { _id: 1 }).lean();
    if (!tenant) throw badRequest('Invalid or expired reset link');
    const user = await User.findOne({ tenantId: tenant._id, passwordResetTokenHash: sha256(body.token) }).select('+passwordResetTokenHash +passwordResetExpires');
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
